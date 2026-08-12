# Pi Mail

Pi Mail is a lightweight local communication layer for independent [Pi](https://github.com/earendil-works/pi) sessions. It gives every Pi session a stable mailbox identity, discovers active peers in the same local project, and exchanges durable asynchronous messages without introducing an orchestrator, daemon, database, or third-party runtime dependency.

The package exposes one compound LLM tool, `mail`, plus an optional `/mail-ui` command for the human user.

## Install

After publication:

```bash
pi install npm:pi-mail
```

For local development:

```bash
pi install /absolute/path/to/pi-mail
```

Pi packages run with the user's local system permissions. Review extension source before installing third-party packages.

## Extension layout

Pi Mail is a directory-style TypeScript extension. Communication code and the Web UI are kept together so the module's protocol, storage, runtime adapter, and human surface evolve as one responsibility.

```text
extensions/pi-mail/
├── index.ts
├── types.ts
├── project-root.ts
├── fs-store.ts
├── mail-service.ts
├── web-ui.ts
├── web/
│   └── index.html
└── SPEC.md
```

Pi loads `extensions/pi-mail/index.ts` directly; there is no build step.

## The `mail` tool

The LLM sees one tool with an `action` field rather than several independent tools. Available actions are `status`, `discover`, `send`, `inbox`, `sent`, `thread`, and `configure`.

```json
{ "action": "discover" }
```

```json
{
  "action": "send",
  "to": ["backend", "reviewer"],
  "cc": ["frontend"],
  "subject": "API compatibility",
  "body": "The response schema changed in commit abc123."
}
```

Message references accept either a full message ID or an unambiguous prefix of at least six characters, so the eight-character IDs shown by Pi Mail can be used directly. Replies preserve the existing thread:

```json
{
  "action": "send",
  "reply_to": "<message-id>",
  "reply_all": true,
  "body": "Reviewed. The schema is fine, but the error shape still differs."
}
```

The reserved address `user` represents the local human supervisor. An agent can mail `user` directly or reply to a message that originated from the Web UI.

## Identity, discovery, and history

A Pi session UUID is the immutable mailbox ID. A mutable alias is initially derived from the Pi session name when available.

Discovery is project-local. In a normal Git repository, the main checkout and all linked worktrees share the main repository's `.pi/mails/` store. Outside Git, the current working directory is the mailbox scope.

Closed sessions remain historical mailbox identities, but normal discovery only returns active and discoverable sessions. `include_inactive: true` exposes historical identities. Message history remains durable after a session closes.

## Storage

Runtime data lives under the canonical project root:

```text
.pi/mails/
├── .gitignore
├── peers/
├── presence/
├── messages/
└── mailboxes/
```

`.pi/mails/.gitignore` contains:

```gitignore
*
!.gitignore
```

Pi Mail never edits the repository root `.gitignore`. Canonical messages are immutable JSON files. Each recipient has an independent delivery-state file, avoiding a shared append log and keeping concurrent local sends simple.

## Native Pi delivery

Durable mail storage and Pi attention are separate concerns. Direct peer-session `To` mail is persisted first and then delivered as a custom Pi message with steering semantics. `Cc` mail is persisted in the same way but does not proactively wake the model.

Peer mail is explicitly marked as coming from another session and must not be treated as human authorization. Mail composed by the user in the Web UI uses the `human` sender kind and is delivered with Pi's user-message API, preserving the authority boundary.

`sent` reports delivery/presentation state, but the `mail` tool no longer sends the storage JSON verbatim into model context. Its model-facing result is a compact mail-oriented text view, while structured data stays in Pi tool `details`. Pi also gets a custom collapsed renderer, so users normally see a short operation summary and can expand the tool row for the readable result. `presentedAt` is not a read receipt; it only means the recipient integration crossed its presentation boundary.

## Web UI

Run:

```text
/mail-ui
```

Pi Mail starts a temporary server on `127.0.0.1` using an ephemeral port, attempts to open it in the default browser, and always prints the URL in Pi. The UI shows the current mailbox status, active and historical sessions, and the latest project messages. The current session is included in the recipient picker, so the user can send to one session, several sessions, or use **To: all active** to select every currently active session. That button expands to ordinary explicit recipients; Pi Mail still has no broadcast/group primitive. Long message and recipient lists scroll inside their panels instead of growing the page indefinitely.

The interface follows the browser's light/dark preference by default, also offers explicit light and dark modes, and can switch between English and Chinese. Its API requires a random bearer token embedded in the launch URL; the token is removed from the address bar after the page stores it for the tab.

Use `/mail-ui close` or the **Close UI server / 关闭 UI 服务** button to stop the server. Closing the Pi session also shuts it down. Pi Mail messaging itself never depends on the Web UI being active.

## Design boundary

Pi Mail deliberately does not model teams, parent/child agents, task assignment, scheduling, spawning, worktree ownership, consensus, wait graphs, rooms, channels, or workflow state. It provides identity, discovery, addressing, durable delivery, threads, recipient state, and Pi-native presentation. Higher-level collaboration patterns belong to callers.

There is no `wait`, Bcc, broadcast, or group lifecycle. Multi-party discussion uses ordinary multi-recipient `To`/`Cc` messages plus thread-preserving replies.

## Development and debugging

The package has no `dependencies` entry. Runtime code uses Node built-ins and Pi-provided peer packages only.

Run the TypeScript tests directly with Node 22's type stripping:

```bash
npm test
npm run pack:check
```

For an end-to-end local test, start two Pi instances in the same repository or linked worktrees with the package installed locally. Use `mail { action: "discover" }` from one session, send a message to the other, and verify native delivery. Run `/mail-ui` in either session to inspect the shared history and send a human-origin message.

For quick extension loading without package installation, Pi also supports its extension flag; the package form is preferable when testing the bundled skill and assets together.

## License

GPL-3.0-only. Copyright (c) frostime.
