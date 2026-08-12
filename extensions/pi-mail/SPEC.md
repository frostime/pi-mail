# Pi Mail Extension Specification

This document is the maintenance contract for the `extensions/pi-mail` module. It records externally observable behavior and invariants that future changes must preserve even when a different implementation would appear simpler.

## Scope boundary

Pi Mail is communication infrastructure. The module may model identities, addressing, discovery, presence, durable messages, recipient delivery state, threads, and presentation into Pi. It must not acquire orchestration semantics such as tasks, roles, parent/child relationships, scheduling, spawning, work ownership, wait graphs, consensus, or workflow state.

The LLM-facing surface remains one compound `mail` tool. New capabilities should normally become actions of that tool rather than separate tools unless Pi itself imposes a technical constraint. Tool `content` is model-facing and should carry the information needed to act without mirroring the full storage JSON shape; structured values may remain in `details` for rendering and session state.

## Identity and discovery

A Pi session UUID is the immutable mailbox identity for that session. Aliases are mutable display addresses and are not durable identity keys. Address resolution may accept an exact session ID, an unambiguous ID prefix, or an alias; ambiguity must fail rather than silently select a peer. Message references used by `reply_to`, `inbox`, and `thread` likewise accept either the exact message ID or an unambiguous prefix of at least six characters.

Session identity survives runtime shutdown. Presence does not. Normal discovery returns only active, discoverable sessions and excludes the caller. Historical identities remain available through `include_inactive` so previously known mailboxes and message attribution remain meaningful after a session closes.

The reserved address `user` maps to the human principal `human-local`. It is addressable but is not a discoverable Pi session and does not participate in presence.

## Project namespace and storage

The mailbox namespace is local to a project. For a normal Git repository, the canonical project root is the parent of Git's shared common directory, so the main checkout and all linked worktrees share one `.pi/mails/` store. Non-Git directories use the current working directory as their scope. Unusual Git layouts must prefer isolation over guessing a broader shared namespace.

Runtime data lives under `<project>/.pi/mails/`. The module creates `.pi/mails/.gitignore` containing `*` and `!.gitignore`; it must not edit the repository root `.gitignore`. Message history and historical peer identities persist until the user removes `.pi/mails/` or a future explicit retention feature does so. Presence files are ephemeral and stale presence is ignored by TTL.

Canonical message files are immutable after creation. Recipient delivery state is stored separately per recipient and may be updated independently. The storage design must not require multiple senders to append to or rewrite one shared mailbox log.

Pi Mail has no third-party runtime dependencies. Node built-ins and Pi-provided peer packages are allowed; adding a new runtime dependency is a product-level change rather than a routine implementation choice.

## Message semantics

A message has one sender, one or more `To` recipients, optional `Cc` recipients, a subject, body, immutable message ID, thread ID, optional parent message ID, and creation time. The same recipient must not appear in both `To` and `Cc`; `To` wins during normalization.

`To` and `Cc` are addressing semantics, not task semantics. The Pi adapter may give them different attention behavior, but mail-core must not infer obligations or workflow state from them.

Replies preserve `threadId` and set `inReplyTo`. A plain reply addresses the parent sender. `reply_all` additionally retains the other original To/Cc participants while excluding the current sender and deduplicating recipients.

Pi Mail 0.1 message records did not contain `senderKind`. Missing `senderKind` must continue to be interpreted as `session` so existing project mail stores remain readable without migration.

## Delivery and presentation semantics

`deliveredAt` means Pi Mail successfully created the recipient's durable delivery record. `presentedAt` is deliberately weaker than a read receipt: it means the Pi integration crossed its presentation boundary, not that an LLM read, understood, accepted, or acted on the message. No feature may present `presentedAt` to callers as proof of comprehension.

Peer-session mail enters Pi as a custom `pi-mail` message and must remain explicitly distinguishable from human instructions. Direct `To` mail may steer/trigger the recipient runtime; `Cc` mail may wait until the next turn. These are adapter attention policies, not protocol obligations.

Mail sent from the Web UI uses the `human` sender kind. On a recipient Pi runtime it must be injected through Pi's user-message API so the authority boundary is truthful. Conversely, peer mail must never be injected as a user message.

## Web UI contract

`/mail-ui` starts an optional local Web UI backed by the same project mail store. `/mail-ui close`, session shutdown, or the page's close action stops that server. The mail system itself must continue to work when the Web UI is not running. The human supervisor view may list the current session and sessions hidden from peer discovery, because `discoverable` controls peer discovery rather than local-user visibility. Selecting “all active” is only a UI convenience that expands to an explicit `To` recipient list; it must not introduce broadcast or group-address semantics into mail-core.

The server binds only to `127.0.0.1` on an ephemeral port. Every `/api/*` request requires a random bearer token supplied in the launch URL and retained by the page. This token requirement must not be removed merely because the server is loopback-only: browser-originated cross-site requests are part of the threat model.

The page must remain usable in both Chinese and English and support automatic, light, and dark appearance. User-provided message content must be rendered as text rather than inserted as trusted HTML.

## Change rules

Schema changes that make existing `.pi/mails` data unreadable require an explicit compatibility or migration strategy. Storage cleanup must never delete canonical messages merely because a session becomes inactive. Changes to discovery scope, human/peer authority mapping, `To`/`Cc` semantics, or the meaning of delivery timestamps are protocol changes and should be documented here and in the changelog.
