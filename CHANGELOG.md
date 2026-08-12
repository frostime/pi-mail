# Changelog

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
