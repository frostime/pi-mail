# Pi Mail Extension Specification

This document is the maintenance contract for `extensions/pi-mail`. It records externally observable behavior and invariants that future changes must preserve even when another implementation appears simpler.

## Scope boundary

Pi Mail is communication infrastructure. It may model identities, addressing, discovery, presence, durable messages, recipient delivery state, threads, notification hints, and presentation into Pi. It must not acquire orchestration semantics such as tasks, roles, parent/child relationships, scheduling, spawning, work ownership, wait graphs, consensus, or workflow state.

The LLM-facing surface remains one compound `mail` tool. Its registration metadata must stay deliberately small; usage policy and examples belong in the bundled `pi-mail` skill rather than `promptGuidelines` or long parameter descriptions. Tool `content` should carry only the information needed for the next model action instead of mirroring storage JSON. Structured values may remain in `details` for rendering and session state.

## Identity, discovery, and session replacement

A Pi session UUID is the immutable mailbox identity. Aliases are mutable display addresses and are not durable identity keys. Address resolution accepts an exact session ID, an unambiguous ID prefix, or an alias; ambiguity fails rather than silently selecting a peer. Message references used by `reply_to`, `inbox`, and `thread` likewise accept exact IDs or unambiguous prefixes of at least six characters.

Session identity survives runtime shutdown, while presence does not. Normal discovery returns only active, discoverable sessions and excludes the caller. Historical identities remain available through `include_inactive` and remain addressable while their mailbox has not been deleted. A send to an inactive historical session is valid: the delivery is persisted, and the sender-facing tool result must disclose that the recipient is inactive rather than implying live delivery.

Pi `/fork`, `/clone`, and other operations that create a new Pi session ID also create a new Pi Mail identity through the ordinary `session_start` path. Pi Mail must not copy the parent mailbox, create mailbox lineage, or automatically notify peers about the fork. The communication layer does not interpret session ancestry. A resumed session with the same Pi session UUID reuses its existing mailbox identity.

The reserved address `user` maps to the human principal `human-local`. It is addressable but is not a discoverable Pi session and does not participate in presence.

## Project namespace and storage

The mailbox namespace is project-local. For a normal Git repository, the canonical project root is the parent of Git's shared common directory, so the main checkout and linked worktrees share one `.pi/mails/` store. Non-Git directories use the current working directory as their scope. Unusual Git layouts must prefer isolation over guessing a broader shared namespace.

Runtime data lives under `<project>/.pi/mails/`. The module creates `.pi/mails/.gitignore` containing `*` and `!.gitignore`; it must not edit the repository root `.gitignore`.

Canonical messages remain one immutable JSON file per message. Recipient delivery state is stored separately per recipient and may be updated independently. The storage design must not require multiple senders to append to or rewrite a shared JSONL/mailbox log. There is no automatic history limit or age-based deletion: silent data loss is worse than gradual local growth for this workload.

The human supervisor may explicitly delete an inactive session mailbox from the Web UI. Deletion removes that session's recipient mailbox state and hides/tombstones the identity from discovery and addressing. It must reject active sessions and the current session. Canonical project messages are shared records and must not be erased merely because one participant mailbox is deleted; this preserves other participants' inbox/sent history and attribution. If the same Pi session UUID is later resumed, normal initialization clears the tombstone and re-registers the identity, but its deleted recipient mailbox state is not reconstructed.

Pi Mail has no third-party runtime dependencies. Node built-ins and Pi-provided peer packages are allowed; adding another runtime dependency is a product-level change.

## Message semantics

A message has one sender, one or more `To` recipients, optional `Cc` recipients, a subject, body, immutable message ID, thread ID, optional parent message ID, creation time, and an optional notification hint. The same recipient must not appear in both `To` and `Cc`; `To` wins during normalization.

`To` and `Cc` are addressing semantics, not task semantics. Replies preserve `threadId` and set `inReplyTo`. A plain reply addresses the parent sender. `reply_all` additionally retains the other original To/Cc participants while excluding the current sender and deduplicating recipients.

Peer mail is non-interruptive by default. `notify: true` is an explicit sender request for immediate attention and applies only to direct `To` deliveries; `Cc` remains silent even when the message carries the flag. Records written before Pi Mail 0.4 have no `notify` field and must be interpreted as `false`. Human-origin Web UI mail is intentionally immediate because it represents a genuine user message, not a peer notification hint.

Pi Mail 0.1 records may also omit `senderKind`; absence must continue to mean `session` so existing project stores remain readable without migration.

## Delivery, backlog notification, and model context

`deliveredAt` means Pi Mail successfully created the recipient's durable delivery record. `presentedAt` is deliberately weaker than a read receipt: it means the Pi integration crossed a presentation boundary, not that an LLM read, understood, accepted, or acted on the message. No feature may present it as proof of comprehension.

Ordinary peer mail must not inject its body into the recipient Pi context merely because it arrived. Explicitly notifying direct mail may be delivered through a `pi-mail` custom message with `steer`/turn triggering. Silent pending mail is summarized only after backlog accumulation: the current adapter threshold is three pending ordinary messages, and reminders occur at new threshold buckets rather than once per poll. Such a reminder reports only the pending count and does not mark those messages as presented.

Model-facing `inbox` without `message_id` is a list view and must use bounded body previews. `thread` is also a bounded preview view. `inbox` with a specific `message_id` returns that received message in full. These rules prevent a single long mailbox or thread lookup from flooding model context; the exact preview character limit is an implementation detail.

Mail sent from the Web UI uses the `human` sender kind. On an active recipient Pi runtime it must be injected through Pi's user-message API so the authority boundary is truthful. Peer mail must never be injected as a user message.

## Web UI contract

`/mail-ui` starts an optional local Web UI backed by the same project mail store. `/mail-ui close`, session shutdown, or the page's close action stops that server. Mail delivery must continue to work while the Web UI is not running.

The human supervisor view may list the current session and sessions hidden from peer discovery because `discoverable` controls peer discovery, not local-user visibility. The compose view may select one, several, or all currently active sessions; “all active” expands to an explicit `To` list and does not introduce broadcast/group semantics into mail-core. Session and message lists must remain scrollable rather than allowing project history to grow the page without bound.

The server binds only to `127.0.0.1` on an ephemeral port. Every `/api/*` request requires the random bearer token supplied in the launch URL. This token requirement must not be removed merely because the server is loopback-only: browser-originated cross-site requests are part of the threat model.

The page must remain usable in Chinese and English and support automatic, light, and dark appearance. User-provided message content must be rendered as text rather than inserted as trusted HTML.

## Change rules

Schema changes that make existing `.pi/mails` data unreadable require an explicit compatibility or migration strategy. Changes to project scoping, address resolution, human/peer authority mapping, To/Cc semantics, offline delivery, notification defaults, mailbox deletion, fork behavior, or delivery timestamp meaning are protocol/product changes and should be documented here and in the changelog.
