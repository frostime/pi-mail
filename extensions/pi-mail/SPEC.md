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

Session short IDs use the random UUID tail rather than the leading timestamp-like portion; nearby time-ordered UUIDs can otherwise share a visible prefix. Session address resolution accepts an exact session ID, an unambiguous leading or trailing ID fragment of at least six characters, or an alias.

New message IDs are complete seven-character lowercase base-36 references. `reply_to`, `inbox`, and `thread` require an exact message ID; a displayed message ID must never become ambiguous as more mail arrives. Creation uses exclusive canonical-file creation as the cross-process collision check and retries a newly generated ID on `EEXIST`. UUID-era messages remain readable and display their complete UUID. Their old six-or-more-character leading or trailing references remain accepted only as a compatibility input path; they are not displayed for new or legacy messages.

Ambiguous legacy message or session ID fragments fail and list candidates. Explicitly duplicated aliases are resolved to the one active match only when exactly one matching session is active; otherwise the operation fails with the ambiguous candidates instead of silently choosing a mailbox.

## Project scope and persistence

The mailbox namespace is project-local. For a normal Git repository, the canonical project root is the parent of Git's shared common directory, so the main checkout and linked worktrees share one `.pi/mails/` store. Non-Git directories use the current working directory as their scope. Unusual Git layouts must prefer isolation over guessing a broader shared namespace.

Runtime data lives under `<project>/.pi/mails/`. The module creates `.pi/mails/.gitignore` containing `*` and `!.gitignore`; it must not edit the repository root `.gitignore`.

Canonical messages remain one immutable JSON file per message. Recipient delivery state is stored separately per recipient and may be updated independently. The storage design must not require multiple senders to append to or rewrite a shared JSONL or mailbox log. There is no automatic history limit or age-based deletion: silent data loss is worse than gradual local growth for this workload.

The human user may explicitly delete an inactive session mailbox from the Web UI. Deletion removes that session's recipient mailbox state, presence, and peer record so it disappears immediately from discovery, addressing, and Web UI recipient lists. Active sessions and the current session must be rejected. Canonical project messages are shared records and must not be erased merely because one participant mailbox is deleted; other participants' inbox/sent history and attribution must remain intact.

Pi Mail 0.4 tombstoned peer records remain readable for compatibility and are filtered from listings. If the same session UUID is later resumed, initialization re-registers the identity, but its deleted recipient mailbox state is not reconstructed.

Pi Mail has no third-party runtime dependencies. Node built-ins and Pi-provided peer packages are allowed; adding another runtime dependency is a product-level change.

## Message and thread semantics

A message has one sender, one or more `To` recipients, optional `Cc` recipients, a subject, body, immutable message ID, thread ID, optional parent message ID, creation time, and an optional notification hint. The same recipient must not appear in both `To` and `Cc`; `To` wins during normalization. A root message's ID is also its internal thread ID; replies preserve it. Thread IDs are storage relationships, not Agent references: Agent operations locate a thread through any message ID, so model-facing mail content must not expose a separate thread ID.

`To` and `Cc` are addressing semantics, not task semantics. Replies preserve `threadId` and set `inReplyTo`. A plain reply addresses the parent sender. `reply_all` retains the other original `To`/`Cc` participants, excludes the current sender, and deduplicates recipients. It is a snapshot of the original participants; later thread participants are not added automatically.

Peer mail is non-interruptive by default. `notify: true` is an explicit sender request for immediate attention and applies only to direct `To` deliveries; `Cc` remains silent even when the message carries the flag. Records written before Pi Mail 0.4 may omit `notify`; absence means `false`. Pi Mail 0.1 records may also omit `senderKind`; absence means `session`.

Human-origin Web UI mail uses sender kind `human`, the `human-local` principal, and is intentionally immediate because it represents a genuine user message rather than a peer notification hint.

## Delivery and presentation

`deliveredAt` means Pi Mail successfully created the recipient's durable delivery record. `presentedAt` means that the Pi integration crossed a presentation boundary. It is weaker than a read receipt: it does not prove that an LLM read, understood, accepted, or acted on the message. No feature may present it as proof of comprehension.

### Peer delivery and attention

Ordinary peer mail must not inject its body into the recipient Pi context merely because it arrived. When an unpresented direct `To` delivery has `notify: true`, the recipient Pi process inserts a `pi-mail` custom message whose content identifies it as peer-session mail, then sends it with `deliverAs: "steer"` and `triggerTurn: true`. It must never be injected as a user message. `Cc` deliveries remain silent even when the message carries `notify: true`.

The adapter records urgent peer mail as presented only after the matching custom message is durable in session history. If Pi exits before that history entry exists, the delivery remains unpresented and may be retried on resume. Human-origin mail uses the user-message authority channel and is presented first when one scan contains several attention lanes.

Quiet direct `To` mail is governed by one recipient-owned reminder policy: `off`, `after-turn`, or `after-minutes` from 1 through 1440. Count alone never starts a model turn; the former three-message threshold and bucket notices are removed. `off` is a clean guarantee that quiet mail cannot start a turn because of age, count, or Agent lifecycle. It does not disable urgent peer or human-origin delivery.

An eligible quiet nudge is emitted only while Pi is idle, with `deliverAs: "followUp"` and `triggerTurn: true`. While Pi is busy, the runtime records only an `agent_settled` recheck and does not pre-queue a Pi message, so changing the effective policy to `off` before settlement cancels the nudge. A nudge contains the total quiet-direct pending count and inbox guidance but no mail body. It does not advance `presentedAt`.

Each `pi-mail-nudge` stores `{ messageIds, pendingCount, reason }` details. `messageIds` is the oldest-first, previously unnudged cohort from one complete mailbox snapshot; `pendingCount` includes older already nudged quiet mail that remains unpresented. Accepted IDs suppress duplicate calls until matching entries become durable, and all current session entries reconstruct durable receipts on reload. New quiet mail may form a later cohort. Exactly-once behavior across concurrently active runtimes sharing one mailbox is not guaranteed.

The Pi adapter exposes the current mailbox's unpresented `To` plus `Cc` count through an informational footer status such as `mail 2`. The footer and Web UI are passive indicators and must not change delivery or presentation state.

### Reminder configuration

The effective reminder source is resolved in this order: mailbox override, trusted project `npm:pi-mail.reminder`, global `npm:pi-mail.reminder`, then built-in `off`. Settings defaults are read-only process configuration and are never copied into an inheriting peer record. Project settings come from the active `ctx.cwd` through Pi's SettingsManager and are ignored when the project is untrusted. Invalid scopes warn once per loaded runtime and fall through independently.

Linked worktrees share peer records but may resolve different trusted project defaults. Therefore cross-mailbox observation never applies the current runtime's default to another inheriting mailbox: the current mailbox and explicit peer overrides expose canonical reminder status, while a non-self mailbox with no override exposes `reminder: null`. This means the observer cannot know that session's runtime-local effective policy; it is not an additional policy mode.

`/mail-reminder` is read-only and reports the canonical mode and source plus concise help. `/mail-reminder off|after-turn|<1-1440>` writes a mailbox override; `/mail-reminder default` removes it. Successful changes request one Attention re-evaluation. The first mutation in a loaded session may show one settings hint when neither scope provides a valid default.

Peer records use version 2 with optional `reminder`: absence means inherit, and `"off"`, `"after-turn"`, or an integer from 1 through 1440 are the only valid overrides. The storage boundary is the sole compatibility decoder. Legacy version 1 positive minute values become matching overrides; absent, `null`, or `0` becomes explicit `off` so upgrade cannot silently enable turns. Version 2 records containing the legacy `reminderAfterMinutes` field, malformed reminders, and unknown versions fail with an identifying error. Current writes never emit `reminderAfterMinutes`.

Downgrading is not guaranteed to preserve version 2 reminder state: an older Pi Mail may collapse inheritance or minute/after-turn overrides to its absent/off representation when it rewrites the peer. Canonical messages and delivery records remain readable across that downgrade.

### Model-facing views

`inbox` without `message_id` is a list view and must use bounded body previews. Mail previews must include the message creation timestamp so an Agent can establish message order. `inbox` with a specific `message_id` returns that received message in full and normally marks its delivery presented. Full messages must include the creation timestamp and delivery kind when available. `thread` and `sent` use bounded or summary views and must not mark deliveries presented; both must retain each message's creation timestamp. `wait` is preview-oriented and must not mark deliveries presented, but its returned previews must include creation timestamps. The exact preview character limit is an implementation detail; the bound prevents one long mailbox, wait result, or thread lookup from flooding model context.

Pi-injected peer and human messages must also include the message creation timestamp so the conversational presentation preserves ordering context. Agent-facing message views expose the complete usable message ID exactly once and omit internal thread IDs. Session IDs appear in discovery, status, or ambiguity resolution where they are actionable; routine mail previews, full messages, send results, and injected peer mail use aliases without repeating session IDs.

Mail sent from the Web UI must be injected through Pi's user-message API on an active recipient runtime so the authority boundary is truthful. Web UI observation is read-only with respect to delivery state.

## Wait semantics

`wait` watches the whole mailbox, not a sender, thread, task, or workflow state. It is an inbox-level synchronization primitive, not an orchestration primitive.

Before blocking, it snapshots current delivery IDs and checks existing unpresented mail. If pending mail already exists, it returns immediately. Otherwise any delivery absent from that snapshot satisfies the wait. This ordering preserves the no-lost-wakeup property when a message arrives around wait startup.

A wait is always finite and abortable. The adapter default is 60 seconds and the public tool caps `timeout_seconds` at 300 seconds. A timeout means only that no mail satisfied the wait during that interval. Returning a preview does not advance `presentedAt`, so an ignored pending message may satisfy a later `wait` again until the agent explicitly inspects its inbox.

## Web UI and security

`/mail-ui` starts an optional local Web UI backed by the same project mail store. `/mail-ui close`, Pi session shutdown, or the page's close action stops that server. Mail delivery continues while the Web UI is not running.

`/mail-status` is a read-only user-facing command. It prints the current mailbox alias, session name, discoverability, active peer count, unpresented `To`/`Cc` counts, the oldest waiting direct delivery age, and the effective reminder. It never changes delivery or presentation state.

`/mail-rename <name>` sets the current mailbox alias through the same validation as the configure tool: 1–64 characters, no slashes or control characters. Running it without an argument reports the current alias and usage. Aliases need not be unique; the command warns when another mailbox already uses the chosen name because addressing may then require the session ID.

The user view may list the current session and sessions hidden from peer discovery because `discoverable` controls peer discovery, not local-user visibility. The compose view may select one, several, or all currently active sessions. “All active” expands to an explicit `To` list and does not introduce broadcast or group semantics into the mail protocol.

Session and message lists must remain scrollable rather than allowing project history to grow the page without bound. Session cards must expose pending `To`/`Cc` counts and enough age information for the user to notice stalled mailboxes without opening every session. The user view must not mark those messages presented.

The server binds only to `127.0.0.1` on an ephemeral port. Every `/api/*` request requires the random bearer token supplied in the launch URL. This token requirement must not be removed merely because the server is loopback-only: browser-originated cross-site requests are part of the threat model.

The page must remain usable in Chinese and English and support automatic, light, and dark appearance. User-provided message content must be rendered as text rather than inserted as trusted HTML.

## Compatibility and change rules

Changes that make existing `.pi/mails` data unreadable require an explicit compatibility or migration strategy. Existing records without `senderKind` remain session-origin messages; existing records without `notify` mean `false`. Pi Mail 0.4 tombstoned peer records remain readable and filtered from listings.

Changes to project scoping, generated-alias migration, address resolution, human/peer authority mapping, `To`/`Cc` semantics, offline delivery, notification defaults, reminder policy or precedence, mailbox deletion, fork behavior, or delivery timestamp meaning are protocol or product changes. Document them here and in the changelog, and add compatibility coverage before implementation.
