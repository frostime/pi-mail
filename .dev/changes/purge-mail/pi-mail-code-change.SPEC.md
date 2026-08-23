# Pi Mail — Mailbox GC & Bulk Deletion Code Change SPEC

Status: **Implemented and verified in the supplied 0.8.0 source tree**
Target baseline: `pi-mail` 0.8.0 (`main` ZIP supplied by user)

## 1. Objective

Change mailbox deletion from “remove mailbox state but retain all canonical messages forever” to **ownership-based garbage collection**, and make inactive mailbox cleanup practical through **multi-select bulk deletion in the Web UI**.

Success means:

1. deleting a mailbox never removes a message still owned by another extant session mailbox;
2. a canonical message with no extant session mailbox owner is eligible for deletion;
3. deleting multiple inactive mailboxes is one user action and one service operation;
4. active mailboxes and the current mailbox remain undeletable;
5. storage remains file-based, dependency-free, and compatible with existing message/delivery formats;
6. the change does not add a second persistent ownership index or refcount database.

## 2. Non-goals

This change does **not** add:

- age/size-based retention policies;
- periodic/background GC;
- TUI mailbox management;
- deletion of individual messages from an otherwise retained mailbox;
- reconstruction of deleted mailboxes on session resume;
- new runtime dependencies;
- a new storage format for existing peer, message, or delivery records.

GC is tied to an explicit human mailbox-deletion action. It is not a general-purpose history expiry mechanism.

## 3. New ownership invariant

A canonical `messages/<messageId>.json` exists only while at least one **extant session mailbox** owns it.

A session mailbox owns a message when either condition is true:

```text
sender ownership:
  message.senderKind == "session"
  AND message.from identifies an extant peer/mailbox

recipient ownership:
  an extant peer/mailbox has a DeliveryRecord for message.id
```

Therefore:

```text
live(message) = senderOwnerExists(message)
             OR recipientDeliveryOwnerExists(message)

!live(message) => message is GC-eligible
```

Important consequences:

- deleting only a recipient mailbox does **not** delete mail while the sender mailbox still exists;
- deleting only the sender mailbox does **not** delete mail while any recipient mailbox still has its delivery;
- deleting every owning mailbox makes the message collectible;
- To/Cc fan-out is safe because each surviving recipient delivery is an independent root;
- a deleted/tombstoned legacy peer is not an owner;
- `human-local` is not treated as an undeletable session mailbox root. Human-origin mail is retained by its session recipients and becomes collectible when no session mailbox owns it.

Thread relationships (`threadId`, `inReplyTo`) are **not ownership roots**. A thread is an index relationship, not a reason to retain an otherwise unreachable body forever.

## 4. GC design

### 4.1 Responsibility split

`FsMailStore` owns filesystem mechanics only:

```ts
removeMessage(messageId: string): Promise<void>
```

`MailService` owns domain policy:

```ts
collectUnreferencedMessages(): Promise<MessageGcResult>
```

The GC policy stays out of `FsMailStore`; the store should not know what “owned by a mailbox” means.

No new `sent/` index or refcount file is introduced. Sender ownership is derived from the canonical `MessageRecord.from`; recipient ownership is derived from existing delivery records. This avoids a second source of truth and migration logic.

### 4.2 Mark-and-sweep

Conceptually:

```text
peers = extant non-tombstoned session peers
roots = Set<messageId>()

for each canonical message:
    if senderKind is session and sender peer exists:
        roots.add(message.id)

for each extant peer:
    for each delivery in peer mailbox:
        roots.add(delivery.messageId)

for each canonical message:
    if message.id not in roots:
        removeMessage(message.id)
```

Expected complexity is linear in project mail state: `O(peers + deliveries + messages)`.

The implementation should read the ownership snapshot once per sweep rather than repeatedly calling `getPeer()` for every message.

### 4.3 Trigger

GC runs **once after a successful explicit mailbox deletion/batch deletion**.

```text
validate entire batch
→ delete selected mailboxes
→ one GC sweep
→ return deleted mailbox list + GC count
```

Running GC once after the whole batch matters: deleting N mailboxes must not perform N full scans.

### 4.4 Failure behavior

Mailbox eligibility validation is all-or-nothing: if any requested mailbox is current, active, missing, human, or otherwise invalid, no mailbox in that batch is deleted.

Filesystem deletion across multiple files cannot be truly transactional without introducing a cross-process transaction/lock subsystem. This change will not add such a subsystem. Operations remain idempotent where practical, use the existing atomic-file conventions, and GC only deletes messages proven unreachable in its observed snapshot.

A GC failure must be reported to the Web UI rather than silently presented as complete success. The mailbox deletion itself may already have completed; the response/error text must distinguish “mailbox deletion failed” from “mailboxes deleted but message cleanup failed” if this partial state occurs.

## 5. Mailbox deletion service API

Introduce a batch-domain operation and make the current single-delete method delegate to it.

Proposed shape:

```ts
interface MessageGcResult {
  deletedCount: number;
}

interface DeleteProjectMailboxesResult {
  mailboxes: PeerAddress[];
  gc: MessageGcResult;
}

MailService.deleteProjectMailboxes(sessionIds: string[]): Promise<DeleteProjectMailboxesResult>

MailService.deleteProjectMailbox(address: string): Promise<PeerAddress>
// compatibility wrapper; internally resolves one mailbox and uses the same deletion path
```

The batch API accepts exact session IDs from Web UI state. It must deduplicate IDs before validation/mutation.

Validation rules remain:

- human principal: reject;
- current session: reject;
- any active runtime for target: reject;
- missing/deleted peer: reject.

All targets are validated before the first destructive write.

## 6. Web API

Prefer one batch endpoint:

```http
POST /api/delete-mailboxes
Content-Type: application/json

{
  "session_ids": ["...", "..."]
}
```

Response:

```json
{
  "mailboxes": [
    { "id": "...", "shortId": "...", "alias": "..." }
  ],
  "gc": {
    "deletedCount": 12
  }
}
```

The old `/api/delete-mailbox` endpoint may remain temporarily as a compatibility shim if tests or external callers rely on it, but both endpoints must use the same service implementation. There must not be two deletion algorithms.

## 7. Web UI

### 7.1 Interaction

Inactive, non-current session cards gain a selection checkbox. Active/current sessions are visibly non-selectable.

The Sessions panel gains a compact bulk action row:

```text
[ Select inactive ]   3 selected   [ Delete selected ]
```

Behavior:

- selection survives the 3-second refresh only for IDs that remain selectable;
- `Select inactive` selects all currently deletable mailboxes;
- `Delete selected` is disabled when selection is empty;
- one confirmation covers the entire batch;
- confirmation explicitly states that messages no longer owned by any remaining session mailbox will also be deleted;
- after success, refresh state and report both mailbox and message counts.

Recommended confirmation copy:

```text
Delete 3 inactive mailboxes?
Their mailbox state will be removed. Messages still owned by other mailboxes are kept; messages with no remaining mailbox owner are deleted.
```

The existing per-card single-delete button may remain, but it must call the same `deleteMailboxes([peer.id])` client function. This preserves the current fast path without creating a second behavior.

### 7.2 State management

Keep one client-side `Set` of selected mailbox IDs. `renderPeers()` intersects that set with the current deletable IDs on each refresh.

Do not couple deletion selection with Compose recipient checkboxes; they represent different tasks and should remain separate state.

## 8. Existing specification changes

`extensions/pi-mail/SPEC.md` currently requires canonical messages to survive mailbox deletion and states that automatic provisional cleanup must not delete canonical messages.

The revised contract should preserve the provisional-cleanup rule (a provisional mailbox has no meaningful mail and therefore does not need a GC side effect) but replace the explicit-deletion invariant with:

> Explicit human deletion removes the selected inactive mailbox state. After the deletion batch, Pi Mail garbage-collects canonical messages that are no longer owned by any extant session mailbox. Sender ownership and recipient delivery ownership are both roots; deleting one participant must not erase mail still owned by another participant.

Also replace “no automatic history cap” wording with a more precise distinction:

> Pi Mail has no age- or size-based history cap. Canonical messages may nevertheless be removed by reference-based GC after explicit mailbox deletion.

README/README.zh-CN and CHANGELOG must describe the same semantics.

## 9. Test plan

### Service / GC

Required cases:

1. recipient deleted, sender survives → message survives;
2. sender deleted, recipient survives → message survives;
3. sender + only recipient deleted in one batch → message removed;
4. To/Cc message with one surviving recipient → message survives;
5. last remaining recipient later deleted → message removed;
6. human-origin message with surviving session recipient → survives;
7. human-origin message with no surviving session recipient → removed;
8. legacy/tombstoned peer does not keep a message alive;
9. invalid member in a batch → entire batch rejected before mutation;
10. duplicate session IDs → one deletion only;
11. active/current mailbox in batch → batch rejected;
12. single-delete compatibility method uses the same semantics.

### Web API / UI

Required cases:

- `/api/delete-mailboxes` rejects unauthenticated requests;
- batch request removes all valid selected inactive peers;
- response includes mailbox count/data and GC count;
- HTML contains bilingual bulk-selection/deletion labels;
- rendered active/current sessions cannot be selected;
- refresh prunes stale selection;
- single and bulk paths share the same client deletion function.

## 10. Files expected to change

```text
extensions/pi-mail/SPEC.md
extensions/pi-mail/fs-store.ts
extensions/pi-mail/mail-service.ts
extensions/pi-mail/web-ui.ts
extensions/pi-mail/web/index.html

test/mail-service.test.ts
test/web-ui.test.ts

README.md
README.zh-CN.md
CHANGELOG.md
```

No new production module is planned unless implementation reveals enough GC-specific complexity to justify a deep abstraction. The default is to keep the domain rule in `MailService` and filesystem primitive in `FsMailStore`.

## 11. Architectural rationale

This design minimizes new conceptual surface:

```text
existing facts                         new behavior
────────────────────────────────────────────────────────────
peer exists                  ┐
message.from                 ├─→ derive ownership → GC
recipient DeliveryRecord     ┘

existing delete semantics ─────→ batch validation/deletion
existing Web UI session list ───→ selection + one batch action
```

It deliberately avoids:

```text
new refcount database
new sent-message index
new background scheduler
new storage version
new dependency
separate single/bulk deletion implementations
```

The key abstraction is **message reachability from extant mailboxes**. Details of filesystem traversal stay below the service boundary; UI only sees “delete these mailboxes” and the cleanup result.

## 12. Acceptance criteria

The implementation is acceptable when:

- all source changes implement the ownership invariant above;
- no retained mailbox loses inbox or sent history because another mailbox was deleted;
- a message loses its canonical file after its final session mailbox owner is explicitly deleted;
- bulk deletion works for multiple inactive sessions in one confirmation/action;
- active/current mailbox protections remain enforced server-side, not only in UI;
- existing message/delivery JSON remains readable without migration;
- no runtime dependency is added;
- updated tests pass in a dependency-complete environment;
- `npm pack --dry-run` remains valid.


## 11. Implementation verification

Implemented without new runtime dependencies or persistent ownership indexes. The production change is limited to the existing store, MailService, Web API/UI, and maintenance documentation.

Verification performed in the execution environment:

- GC ownership and bulk deletion tests pass, including sender/recipient survival, last-owner collection, To/Cc fan-out, human-origin mail, tombstones, batch pre-validation, deduplication, and partial GC failure reporting.
- Web UI/API tests pass for the new batch endpoint and the legacy single-delete compatibility endpoint.
- All tests that do not require unavailable Pi-provided packages pass (70/70).
- The repository-wide `npm test` reaches 70 passing tests and 2 environment-only import failures because `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are not installed in this container; the same two failures existed before the change.
- The embedded Web UI script passes `node --check`; package dry-run succeeds.
