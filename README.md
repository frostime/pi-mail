# Pi Mail

Pi Mail is a lightweight local communication layer for independent [Pi](https://github.com/earendil-works/pi) sessions. Every Pi session gets a stable mailbox identity, peers can discover one another inside the same project, and mail remains durable when a recipient is offline. Pi Mail intentionally does not provide orchestration, scheduling, tasks, teams, or agent spawning.

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

## Mail tool

The model sees one compact tool with an `action` field. Detailed behavior lives in the bundled `pi-mail` skill so the always-visible tool schema stays small. Actions are `status`, `discover`, `send`, `inbox`, `sent`, `thread`, `wait`, and `configure`.

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

Peer mail is quiet by default. Add `"notify": true` only when direct `To` recipients should be actively interrupted. `Cc` remains silent.

`inbox` and `thread` use bounded body previews. `inbox` with a `message_id` reads one received message in full. Message references accept full IDs or unambiguous fragments.

### Wait

`wait` is a finite inbox wait, useful when another session is expected to reply:

```json
{ "action": "wait", "timeout_seconds": 60 }
```

It first checks whether unpresented mail already exists and returns immediately if so. Otherwise it snapshots the current inbox and waits for any later delivery. This avoids the lost-wakeup case where a reply arrived just before the tool call. The default timeout is 60 seconds and the public maximum is 300 seconds. A timeout simply returns control to the agent. `wait` is non-consuming: it returns bounded previews without advancing `presentedAt`. After it wakes, use `inbox` to inspect the relevant message; if you do not, a later `wait` may intentionally return the same still-pending mail again.

## Identity and session names

The immutable mailbox ID is the Pi session UUID. The human-facing short session ID uses the UUID tail rather than its leading portion, because nearby time-ordered session IDs may share a long prefix. A displayed short session ID is directly usable as an address. Earlier leading ID fragments remain accepted for compatibility.

The mailbox alias and Pi conversation/session name are separate metadata. The alias is a communication address; the Web UI also shows Pi's session name so historical and active sessions are easier for a human to recognize. The extension refreshes that name during its normal heartbeat.

Normal discovery lists active, discoverable sessions. `include_inactive: true` also exposes historical mailboxes. Sending to an inactive mailbox is valid; the sender-facing result explicitly reports that the recipient is inactive while confirming durable delivery.

A Pi `/fork` or `/clone` that creates a new Pi session UUID gets a new mailbox identity. Pi Mail does not copy mailbox contents, create parent/child lineage, or automatically announce the fork. Resuming the same session UUID reuses its mailbox.

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

Each canonical message is one immutable JSON file. Recipient delivery state is stored separately, avoiding shared JSONL append locks. Pi Mail does not automatically delete old messages or impose a history cap.

## Notification behavior

Durable delivery and model attention are separate. Ordinary peer mail enters the mailbox silently. A peer message with `notify: true` may steer/trigger direct `To` recipients. When ordinary direct mail accumulates to three pending messages, Pi Mail sends a lightweight count-only reminder at threshold buckets rather than injecting every body. `Cc` does not trigger this backlog attention path.

The human user may optionally enable a stale-mail reminder for the current mailbox:

```text
/mail-reminder 30
/mail-reminder off
```

It is disabled by default. When enabled, one or two quiet direct `To` messages that remain unpresented for the configured age may trigger a count-only Pi turn. The reminder is a user-owned attention policy, not a mail protocol field and not an orchestration primitive. Web UI observation does not mark agent mail as presented or suppress this policy.

The Pi footer shows a compact `mail N` status whenever the current session has unpresented inbox mail. The indicator is informational and disappears when the pending count returns to zero.

`presentedAt` is not a read receipt. It means only that the Pi integration crossed its presentation boundary.

## Web UI

Run `/mail-ui` to start a token-protected server on `127.0.0.1`. The UI supports English/Chinese, automatic/light/dark themes, multiple To/Cc recipients, the current session, and **To: all active**.

Session cards and recipient rows show the Pi session name when available, with mailbox alias and short ID underneath. Session cards also show pending To/Cc counts, the age of the oldest pending direct message, and any configured stale-mail reminder; mailboxes needing attention are sorted ahead of quiet mailboxes. Inactive mailboxes can be deleted by the human supervisor. Deletion removes the peer record and recipient mailbox state immediately, so deleted sessions disappear from the compose recipient list. Shared canonical messages remain available to other participants. If the same Pi session UUID is later resumed, it registers again with an empty recipient inbox.

Use `/mail-ui close` or the page close button to stop the server. Pi also emits `session_shutdown` when the owning session exits, reloads, switches, or forks, and Pi Mail closes that session's Web UI during the shutdown handler. Mail delivery itself does not depend on the Web UI.

The reserved address `user` represents the local human supervisor. Messages composed in the Web UI enter recipient Pi sessions as genuine user messages; peer mail never does.

## Development

The package has no `dependencies` entry. Runtime code uses Node built-ins and Pi-provided peer packages only.

```bash
npm test
npm run pack:check
```

For an end-to-end test, install the package locally, open two Pi sessions in the same repository or linked worktrees, test `discover`, quiet/notify `send`, `wait`, offline delivery, and `/mail-ui`.

## License

GPL-3.0-only. Copyright (c) frostime.
