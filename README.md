# Pi Mail

Pi Mail is a lightweight local communication layer for independent [Pi](https://github.com/earendil-works/pi) sessions. Every Pi session gets a stable mailbox identity, active peers can be discovered inside the same project, and messages remain durable even when the recipient is offline. Pi Mail intentionally does not provide orchestration, scheduling, tasks, teams, or agent spawning.

The package exposes one compound LLM tool, `mail`, plus an optional `/mail-ui` command for the human supervisor. Runtime code has no third-party dependencies.

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

```text
extensions/pi-mail/
├── index.ts
├── types.ts
├── attention-policy.ts
├── project-root.ts
├── fs-store.ts
├── mail-service.ts
├── tool-presentation.ts
├── web-ui.ts
├── web/
│   └── index.html
└── SPEC.md
```

Pi loads `extensions/pi-mail/index.ts` directly; there is no build step.

## Mail tool

The model sees one tool with an `action` field. Detailed usage rules live in the bundled `pi-mail` skill so tool-registration token cost stays small. Available actions are `status`, `discover`, `send`, `inbox`, `sent`, `thread`, and `configure`.

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

Peer mail is quiet by default. Add `"notify": true` only when direct `To` recipients should be actively interrupted:

```json
{
  "action": "send",
  "to": ["reviewer"],
  "subject": "Review needed now",
  "body": "Please review commit abc123.",
  "notify": true
}
```

Message references accept a full ID or an unambiguous prefix of at least six characters. `inbox` without `message_id` and `thread` return compact body previews; `inbox` with `message_id` reads one received message in full.

The reserved address `user` represents the local human supervisor. Human-origin Web UI messages enter Pi as genuine user messages; peer messages never do.

## Identity, offline delivery, and forks

The immutable mailbox ID is the Pi session UUID. A mutable alias is derived from the Pi session name when available. Normal discovery lists active, discoverable sessions; `include_inactive: true` also exposes historical mailboxes.

An inactive historical mailbox remains addressable. Sending to it persists the message normally, and the tool result explicitly reports that the recipient is inactive. When that Pi session is resumed, its mailbox is available again.

A Pi `/fork` or `/clone` that creates a new Pi session UUID also creates a new mailbox identity. Pi Mail does not copy the parent mailbox, record parent/child lineage, or automatically notify other sessions. A normal resume of the same session UUID reuses the existing mailbox.

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

For a normal Git repository, the main checkout and linked worktrees share the same project store. `.pi/mails/.gitignore` contains `*` and `!.gitignore`; Pi Mail never edits the repository root `.gitignore`.

Each canonical message is one immutable JSON file, while recipient delivery state is kept separately. This avoids shared append logs and cross-process JSONL locking. Pi Mail does not automatically delete old messages or impose a history cap.

## Notification behavior

Durable delivery and model attention are separate. Ordinary peer mail enters the mailbox silently. A peer message with `notify: true` may steer/trigger direct `To` recipients; `Cc` stays silent. If ordinary unpresented mail accumulates, the Pi adapter sends a lightweight count-only reminder at three pending messages and again only when a later threshold bucket is reached. The reminder does not inject all message bodies or mark them as presented.

`presentedAt` is not a read receipt. It only means the Pi integration crossed its presentation boundary; it does not prove that the model understood or acted on the message.

## Web UI

Run `/mail-ui` to start a temporary token-protected server on `127.0.0.1`. The UI supports English and Chinese, automatic/light/dark themes, one or many To/Cc recipients, the current session, and **To: all active**. Session, recipient, and message lists scroll within their panels.

The human supervisor can delete an **inactive** session mailbox from the Sessions panel. This removes that session's inbox delivery state and makes the mailbox no longer addressable. Shared canonical messages remain available to other participants so deleting one mailbox does not rewrite everyone else's history. If that same Pi session UUID is later resumed, it re-registers as a fresh mailbox identity with no reconstructed inbox state.

Use `/mail-ui close` or the page's close button to stop the server. Mail delivery itself does not depend on the Web UI.

## Development

The package has no `dependencies` entry. Runtime code uses Node built-ins and Pi-provided peer packages only.

```bash
npm test
npm run pack:check
```

For an end-to-end test, install the package locally, open two Pi sessions in the same repository or linked worktrees, discover/send between them, try both quiet and `notify: true` mail, then open `/mail-ui` to inspect history and human-origin messaging.

## License

GPL-3.0-only. Copyright (c) frostime.
