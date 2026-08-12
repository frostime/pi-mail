# Pi Mail Extension Specification

This document is the maintenance contract for `extensions/pi-mail`. It records behavior and invariants that future implementations must preserve even when another design appears simpler.

## Scope and public surface

Pi Mail provides communication between independent Pi sessions. It may model identities, addresses, discovery, presence, durable messages, recipient delivery state, threads, notification hints, and presentation into Pi.

It must not acquire orchestration semantics such as tasks, roles, parent/child relationships, scheduling, spawning, work ownership, wait graphs, consensus, or workflow state.

The model-facing surface is one `mail` tool. Keep its registration metadata compact. Usage policy and examples belong in the bundled `pi-mail` skill rather than `promptGuidelines` or long parameter descriptions. Tool `content` should contain only what the model needs for its next action; storage-shaped data may remain in `details` for rendering and session state.

## Identity and addressing

### Session lifecycle

A Pi session UUID is the immutable mailbox identity. A resumed session with the same UUID reuses its mailbox. `/fork`, `/clone`, and other operations that create a new Pi session UUID create an independent Pi Mail identity through the normal `session_start` path. Pi Mail must not copy the parent mailbox, create mailbox lineage, or notify peers about session ancestry.

New sessions receive a generated alias in the compact `S###` form. The number is derived from the session ID, and initialization advances to the next unused generated alias when a project collision occurs. Explicitly configured aliases are mutable user-chosen addresses and are not required to be unique. Existing user-chosen aliases survive resume; legacy generated aliases such as `session-019ff5f7` and `session-<short-id>` migrate to the current `S###` form during initialization.

Pi's conversation/session display name is stored separately from the mailbox alias so the human UI can show both without conflating them. New mailboxes are discoverable by default. `configure` is a partial update: omitted `alias` and `discoverable` values retain their current values. An explicit empty alias is invalid rather than meaning "leave unchanged".

Session identity survives runtime shutdown, while presence does not. Normal `discover` returns only active, discoverable sessions and excludes the caller. Historical identities remain available through `include_inactive` and remain addressable while their mailbox exists. Sending to an inactive historical session is valid: delivery is persisted, and the sender-facing result must say that the recipient is inactive rather than implying live delivery.

The reserved address `user` maps to the human principal `human-local`. It is addressable, but it is not a discoverable Pi session and does not participate in presence.

### Address resolution

Session short IDs use the random UUID tail rather than the leading timestamp-like portion; nearby time-ordered UUIDs can otherwise share a visible prefix. Address resolution accepts an exact session ID, an unambiguous leading or trailing ID fragment of at least six characters, or an alias. Message references used by `reply_to`, `inbox`, and `thread` follow the same exact-or-unambiguous-fragment rule.

Ambiguous ID fragments fail and list candidates. Explicitly duplicated aliases are resolved to the one active match only when exactly one matching session is active; otherwise the operation fails with the ambiguous candidates instead of silently choosing a mailbox.

## Project scope and persistence

The mailbox namespace is project-local. For a normal Git repository, the canonical project root is the parent of Git's shared common directory, so the main checkout and linked worktrees share one `.pi/mails/` store. Non-Git directories use the current working directory as their scope. Unusual Git layouts must prefer isolation over guessing a broader shared namespace.

Runtime data lives under `<project>/.pi/mails/`. The module creates `.pi/mails/.gitignore` containing `*` and `!.gitignore`; it must not edit the repository root `.gitignore`.

Canonical messages remain one immutable JSON file per message. Recipient delivery state is stored separately per recipient and may be updated independently. The storage design must not require multiple senders to append to or rewrite a shared JSONL or mailbox log. There is no automatic history limit or age-based deletion: silent data loss is worse than gradual local growth for this workload.

The human user may explicitly delete an inactive session mailbox from the Web UI. Deletion removes that session's recipient mailbox state, presence, and peer record so it disappears immediately from discovery, addressing, and Web UI recipient lists. Active sessions and the current session must be rejected. Canonical project messages are shared records and must not be erased merely because one participant mailbox is deleted; other participants' inbox/sent history and attribution must remain intact.

Pi Mail 0.4 tombstoned peer records remain readable for compatibility and are filtered from listings. If the same session UUID is later resumed, initialization re-registers the identity, but its deleted recipient mailbox state is not reconstructed.

Pi Mail has no third-party runtime dependencies. Node built-ins and Pi-provided peer packages are allowed; adding another runtime dependency is a product-level change.

## Message and thread semantics

A message has one sender, one or more `To` recipients, optional `Cc` recipients, a subject, body, immutable message ID, thread ID, optional parent message ID, creation time, and an optional notification hint. The same recipient must not appear in both `To` and `Cc`; `To` wins during normalization.

`To` and `Cc` are addressing semantics, not task semantics. Replies preserve `threadId` and set `inReplyTo`. A plain reply addresses the parent sender. `reply_all` retains the other original `To`/`Cc` participants, excludes the current sender, and deduplicates recipients. It is a snapshot of the original participants; later thread participants are not added automatically.

Peer mail is non-interruptive by default. `notify: true` is an explicit sender request for immediate attention and applies only to direct `To` deliveries; `Cc` remains silent even when the message carries the flag. Records written before Pi Mail 0.4 may omit `notify`; absence means `false`. Pi Mail 0.1 records may also omit `senderKind`; absence means `session`.

Human-origin Web UI mail uses sender kind `human`, the `human-local` principal, and is intentionally immediate because it represents a genuine user message rather than a peer notification hint.

## Delivery and presentation

`deliveredAt` means Pi Mail successfully created the recipient's durable delivery record. `presentedAt` means that the Pi integration crossed a presentation boundary. It is weaker than a read receipt: it does not prove that an LLM read, understood, accepted, or acted on the message. No feature may present it as proof of comprehension.

### Peer delivery and attention

Ordinary peer mail must not inject its body into the recipient Pi context merely because it arrived. When an unpresented direct `To` delivery has `notify: true`, the recipient Pi process inserts a `pi-mail` custom message whose content identifies it as peer-session mail, then sends it with `deliverAs: "steer"` and `triggerTurn: true`. It must never be injected as a user message. `Cc` deliveries remain silent even when the message carries `notify: true`.

The adapter records the message as presented only after the custom message is durably present in session history. If Pi exits before that history entry exists, the delivery remains unpresented and may be retried on resume.

Silent direct `To` mail is summarized after backlog accumulation. The current adapter threshold is three pending direct messages, and notices occur when the pending count enters a new threshold bucket rather than once per poll. `Cc` mail is excluded from this count. A backlog notice reports only the pending count and does not mark messages as presented.

A stale-mail reminder is an optional Pi-adapter attention policy owned by the human user, not a message field and not an orchestration primitive. It is disabled by default and configured per mailbox with `/mail-reminder off|<minutes>`. When enabled, quiet unpresented direct `To` mail may trigger one count-only follow-up after the configured age. It must not trigger for `Cc`, `notify: true`, human-origin, or already-presented mail. Within one continuous backlog episode, repeated stale reminders are suppressed; clearing the direct pending backlog rearms the policy. Web UI observation must not mutate `presentedAt` or suppress the recipient-side stale policy.

The Pi adapter exposes the current mailbox's unpresented `To` plus `Cc` count through an informational footer status such as `mail 2`. This status must not change delivery or presentation state.

### Model-facing views

`inbox` without `message_id` is a list view and must use bounded body previews. `inbox` with a specific `message_id` returns that received message in full and normally marks its delivery presented. `thread` and `sent` use bounded or summary views and must not mark deliveries presented. `wait` is preview-oriented and must not mark deliveries presented. The exact preview character limit is an implementation detail; the bound prevents one long mailbox, wait result, or thread lookup from flooding model context.

Mail sent from the Web UI must be injected through Pi's user-message API on an active recipient runtime so the authority boundary is truthful. Web UI observation is read-only with respect to delivery state.

## Wait semantics

`wait` watches the whole mailbox, not a sender, thread, task, or workflow state. It is an inbox-level synchronization primitive, not an orchestration primitive.

Before blocking, it snapshots current delivery IDs and checks existing unpresented mail. If pending mail already exists, it returns immediately. Otherwise any delivery absent from that snapshot satisfies the wait. This ordering preserves the no-lost-wakeup property when a message arrives around wait startup.

A wait is always finite and abortable. The adapter default is 60 seconds and the public tool caps `timeout_seconds` at 300 seconds. A timeout means only that no mail satisfied the wait during that interval. Returning a preview does not advance `presentedAt`, so an ignored pending message may satisfy a later `wait` again until the agent explicitly inspects its inbox.

## Web UI and security

`/mail-ui` starts an optional local Web UI backed by the same project mail store. `/mail-ui close`, Pi session shutdown, or the page's close action stops that server. Mail delivery continues while the Web UI is not running.

The user view may list the current session and sessions hidden from peer discovery because `discoverable` controls peer discovery, not local-user visibility. The compose view may select one, several, or all currently active sessions. “All active” expands to an explicit `To` list and does not introduce broadcast or group semantics into the mail protocol.

Session and message lists must remain scrollable rather than allowing project history to grow the page without bound. Session cards must expose pending `To`/`Cc` counts and enough age information for the user to notice stalled mailboxes without opening every session. The user view must not mark those messages presented.

The server binds only to `127.0.0.1` on an ephemeral port. Every `/api/*` request requires the random bearer token supplied in the launch URL. This token requirement must not be removed merely because the server is loopback-only: browser-originated cross-site requests are part of the threat model.

The page must remain usable in Chinese and English and support automatic, light, and dark appearance. User-provided message content must be rendered as text rather than inserted as trusted HTML.

## Compatibility and change rules

Changes that make existing `.pi/mails` data unreadable require an explicit compatibility or migration strategy. Existing records without `senderKind` remain session-origin messages; existing records without `notify` mean `false`. Pi Mail 0.4 tombstoned peer records remain readable and filtered from listings.

Changes to project scoping, generated-alias migration, address resolution, human/peer authority mapping, `To`/`Cc` semantics, offline delivery, notification defaults, stale reminder policy, mailbox deletion, fork behavior, or delivery timestamp meaning are protocol or product changes. Document them here and in the changelog, and add compatibility coverage before implementation.
