# Changelog

## 0.6.2

Update documentation.

## 0.6.1

Agent-facing mail views now include each message's creation timestamp, including inbox previews, full messages, threads, sent mail, wait results, and Pi-injected peer or human messages. This makes message ordering explicit across concurrent sessions.

## 0.6.0

Added an optional stale-mail reminder policy for the current mailbox. It is disabled by default and controlled by the human user with `/mail-reminder off|<minutes>` (1-1440 minutes). The reminder applies only to quiet, unpresented direct `To` mail; it does not wake for `Cc`, explicit `notify: true` mail, human-origin mail, or already-presented messages. It is intentionally an adapter-level attention policy rather than a mail protocol field or orchestration feature. Existing three-message backlog notices now count only direct `To` mail, preventing informational Cc traffic from waking a session.

The Pi footer now exposes a compact `mail N` indicator whenever the current session has unpresented inbox entries. This uses Pi's extension status slot and does not mutate mailbox state.

The Web UI now exposes per-session mailbox health directly in the session list: pending To/Cc counts, oldest pending direct-mail age, and configured stale-reminder policy. Mailboxes needing attention are sorted ahead of quiet mailboxes. The supervisor view remains observational and does not mark agent deliveries as presented.

## 0.5.1

Session short IDs now use the random UUID tail instead of a fixed leading prefix. This avoids collisions between nearby time-ordered Pi session UUIDs; recipient resolution accepts both leading and trailing unambiguous ID fragments for compatibility. Legacy generated aliases such as `session-019ff5f7` are migrated to tail-based defaults on resume, while user-chosen aliases are preserved. Pi conversation/session names are now stored separately from mailbox aliases, refreshed by the extension heartbeat, and shown in the Web UI.

Added `mail action=wait` with finite, abortable inbox-wait semantics. `wait` first snapshots the current inbox and checks already-pending unpresented mail before blocking; therefore mail that arrived just before the call returns immediately instead of creating a lost-wakeup deadlock. Otherwise any later delivery wakes the call. Wait previews are non-consuming and do not advance `presentedAt`, so existing human/notify delivery semantics are preserved and an ignored pending message remains visible to later waits. The default timeout is 60 seconds and the public maximum is 300 seconds.

Human mailbox deletion now physically removes the inactive peer record in addition to recipient state and presence, so deleted sessions disappear immediately from Web UI recipient choices. Pi Mail 0.4 tombstones remain compatible and continue to be filtered. The bundled skill was tightened around ID addressing, quiet-vs-notify behavior, offline delivery, and safe wait usage, while the always-visible tool description remains deliberately small.

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
