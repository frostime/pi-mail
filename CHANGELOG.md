# Changelog

## 0.2.0

Reworked the package into a cohesive TypeScript directory extension under `extensions/pi-mail/`. The storage and mail service now live with the extension instead of a separate top-level `lib/` directory.

Added `/mail-ui`, a zero-runtime-dependency local Web UI with Chinese/English localization, automatic/light/dark themes, project-wide message inspection, human-origin message composition, and an in-page server shutdown action. The UI binds to loopback on an ephemeral port and protects its API with a random bearer token.

Added the reserved `user` / `human-local` principal. Messages composed in the Web UI are delivered to Pi as genuine user messages; agents may reply to `user` in the same mail thread. Existing 0.1 messages without `senderKind` remain compatible and are interpreted as session-origin messages.

Added `extensions/pi-mail/SPEC.md` as the module maintenance contract and converted tests to TypeScript, including Web UI and legacy-data coverage.

## 0.1.0

Initial release with automatic Pi session identity registration, project-local active peer discovery across Git worktrees, durable filesystem-backed mail, multiple To/Cc recipients, replies and threads, sent delivery metadata, mutable aliases and discoverability, and native Pi delivery for direct and Cc mail.
