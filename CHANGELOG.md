# Changelog

## 0.4.0

Peer mail is now quiet by default. `send` accepts `notify: true` for immediate attention from direct `To` recipients, while `Cc` remains silent. Ordinary pending mail produces only a lightweight mailbox-count reminder after three accumulated messages, and inactive recipients are explicitly reported in the sender-facing result while delivery still succeeds durably.

Model-facing mailbox output is bounded: inbox listings and thread views show short body previews, while `inbox` with a specific `message_id` returns the full received message. Tool registration metadata was reduced substantially; operational guidance now lives in the bundled `pi-mail` skill.

The Web UI can delete inactive session mailboxes under the human supervisor's authority. Deletion removes recipient mailbox state and tombstones the session identity without rewriting shared canonical project messages. The session list is scrollable, and active/current mailboxes cannot be deleted.

Fork/clone semantics are now explicit: a new Pi session UUID gets a new mailbox identity through normal registration; Pi Mail does not copy mailbox state, create lineage, or automatically notify peers. Canonical storage remains one immutable JSON file per message with no automatic history cap.

## 0.3.0

Message references are now consistent with peer addressing: `reply_to` and `message_id` accept exact IDs or unambiguous prefixes of at least six characters. This makes the eight-character IDs shown by Pi Mail directly usable for replies, inbox lookup, and thread lookup.

The Web UI recipient picker now includes the current session and can select all currently active project sessions in one action while still emitting an ordinary explicit `To` list. The human supervisor view is not constrained by peer `discoverable` visibility. Long message and recipient lists now scroll within their panels.

The `mail` tool no longer sends raw storage JSON to the model. Model-facing `content` uses a compact mail-oriented representation, structured objects stay in `details`, and Pi's `renderCall` / `renderResult` hooks provide a compact collapsed TUI view with expanded readable details. `@earendil-works/pi-tui` is declared as a Pi-provided peer dependency, not a third-party runtime dependency.

## 0.2.0

Reworked the package into a cohesive TypeScript directory extension under `extensions/pi-mail/`. The storage and mail service now live with the extension instead of a separate top-level `lib/` directory.

Added `/mail-ui`, a zero-runtime-dependency local Web UI with Chinese/English localization, automatic/light/dark themes, project-wide message inspection, human-origin message composition, and an in-page server shutdown action. The UI binds to loopback on an ephemeral port and protects its API with a random bearer token.

Added the reserved `user` / `human-local` principal. Messages composed in the Web UI are delivered to Pi as genuine user messages; agents may reply to `user` in the same mail thread. Existing 0.1 messages without `senderKind` remain compatible and are interpreted as session-origin messages.

Added `extensions/pi-mail/SPEC.md` as the module maintenance contract and converted tests to TypeScript, including Web UI and legacy-data coverage.

## 0.1.0

Initial release with automatic Pi session identity registration, project-local active peer discovery across Git worktrees, durable filesystem-backed mail, multiple To/Cc recipients, replies and threads, sent delivery metadata, mutable aliases and discoverability, and native Pi delivery for direct and Cc mail.
