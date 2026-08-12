# Pi Mail

[简体中文](./README.zh-CN.md)

**Local mailboxes for independent Pi coding sessions.**

Pi Mail adds a small communication layer to Pi. Each Pi session gets a stable mailbox identity, sessions in the same project can discover one another, and messages remain available even when the recipient is offline. A human supervisor can inspect the same mail system and send messages through a local Web UI.

Pi Mail deliberately stops at communication. It does **not** create teams, assign tasks, spawn agents, schedule work, or decide how sessions should collaborate.

```text
Pi Session A ─┐
Pi Session B ─┼── project-local mail store ── Human Web UI
Pi Session C ─┘
```

## What Pi Mail provides

| For agents | For users |
| --- | --- |
| One compact `mail` tool for discovery, send/reply, inbox, threads, waiting, and mailbox settings | `/mail-ui` for inspecting mailboxes, reading project mail, and composing messages |
| Multiple `To` / `Cc` recipients and durable delivery to inactive sessions | Send to one, several, or all active sessions |
| Quiet delivery by default, with explicit `notify: true` when immediate attention is needed | See pending mailbox state in the Web UI and a compact `mail N` indicator in Pi |
| Threaded replies, short message references, and finite inbox waiting | Optional stale-mail reminders and manual deletion of inactive mailboxes |

The runtime has no third-party NPM dependencies. Storage uses Node filesystem primitives under the project-local `.pi/mails/` directory.

## Agent experience

Pi exposes a single compound tool named `mail`. Detailed usage guidance lives in the bundled `pi-mail` skill, so the always-visible tool schema stays small.

A session can discover active peers:

```text
mail { action: "discover" }
```

It can then send mail to one or several recipients:

```text
mail {
  action: "send",
  to: ["reviewer"],
  cc: ["frontend"],
  subject: "API review",
  body: "The response shape changed in commit abc123."
}
```

Peer mail is quiet by default. If the sender explicitly needs to interrupt direct `To` recipients, it can opt in:

```text
mail {
  action: "send",
  to: ["reviewer"],
  subject: "Review needed now",
  body: "Please check the compatibility regression.",
  notify: true
}
```

Normal mailbox work stays asynchronous. Inbox listings and thread views use bounded previews; a specific message can be opened in full. `wait` provides a finite, non-consuming wait for new or already-pending mail when a reply is expected:

```text
mail { action: "inbox", unpresented_only: true }
mail { action: "wait", timeout_seconds: 60 }
```

If a recipient is inactive, delivery still succeeds as long as that mailbox exists. The sender is told that the recipient is currently inactive, and the message remains waiting until that Pi session resumes.

Messages sent by another Pi session are always identified as peer-session mail, not as human authorization. Messages composed by the human through the Web UI enter Pi as genuine user messages.

## User experience

Pi Mail also gives the human supervisor a project-wide view of the communication layer.

```text
/mail-ui
/mail-ui close

/mail-reminder 30
/mail-reminder off
```

`/mail-ui` starts a token-protected server bound to `127.0.0.1` and opens the local Web UI. The interface supports English and Chinese, light and dark themes, and shows each mailbox with its Pi session name, alias, short ID, active state, pending `To` / `Cc` counts, and the age of the oldest pending direct message.

From the Web UI, the user can read project mail and compose a message to one session, several sessions, or all currently active sessions. Inactive historical mailboxes can also be deleted manually when they are no longer useful. Deleting a mailbox removes that session's recipient state without rewriting shared messages that still belong to other participants.

The Web UI is only a supervisor client; mail delivery does not depend on it being open. Its local server is automatically closed when the owning Pi session shuts down, and it can also be stopped explicitly with `/mail-ui close` or the page close action.

Pi itself shows a compact `mail N` footer status when the current session has unpresented inbox entries. A user can optionally enable a stale-mail reminder for that mailbox with `/mail-reminder <minutes>`; this policy is disabled by default.

## Project scope and persistence

Pi Mail scopes discovery and storage to the current project rather than exposing every Pi session globally. For Git repositories, the main checkout and linked worktrees share the same canonical project root, so sessions working in different worktrees can still find and mail one another.

Runtime data lives here:

```text
.pi/mails/
├── .gitignore
├── peers/
├── presence/
├── messages/
└── mailboxes/
```

`.pi/mails/.gitignore` keeps the mail runtime out of Git without editing the repository's root `.gitignore`.

A Pi session UUID is the immutable mailbox identity. Resuming the same Pi session reuses its mailbox; a fork or clone that receives a new Pi session UUID gets a new mailbox. Historical mailboxes remain addressable until the human explicitly deletes them.

Pi Mail stores each canonical message as an immutable JSON file and keeps recipient delivery state separately. It does not impose an automatic history cap or silently delete old mail.

## Install

After publication:

```bash
pi install npm:pi-mail
```

For local development or testing:

```bash
pi install /absolute/path/to/pi-mail
```

Pi packages run with the user's local system permissions, so review third-party extension source before installing it.

## Development and reference

```bash
npm test
npm run pack:check
```

The bundled [`pi-mail` skill](./skills/pi-mail/SKILL.md) contains the detailed model-facing usage conventions. [`extensions/pi-mail/SPEC.md`](./extensions/pi-mail/SPEC.md) records the compatibility and maintenance contracts that future implementation changes must preserve.

## License

GPL-3.0-only. Copyright (c) frostime.
