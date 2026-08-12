# Pi Mail

[简体中文](./README.zh-CN.md)

**Local mailboxes for independent Pi coding sessions.**

Pi Mail gives Pi sessions a small, project-local mailbox. Each session gets a stable identity, can discover other sessions in the same project, and can exchange messages asynchronously even when a recipient is offline. The user can inspect the same mailboxes and send messages from a local Web UI.

Pi Mail is intentionally limited to communication. It does **not** create teams, assign tasks, spawn agents, schedule work, or decide how sessions should collaborate.

A typical API compatibility review might unfold like this:

```mermaid
sequenceDiagram
    participant A as Session A
    participant B as Session B
    participant U as User

    A->>B: Send quiet mail: review API migration
    Note right of A: "Please check compatibility with the old response format."
    Note over A,B: Quiet peer mail is delivered asynchronously; it does not interrupt B
    B->>B: Pi footer shows mail 1
    B->>B: Call mail with inbox
    B-->>A: Reply with review findings

    U->>B: Send a question from /mail-ui
    Note right of B: Pi receives this as a genuine user message
    B-->>U: Reply to the reserved user address

    A->>B: Send urgent mail with notify: true
    B->>B: Pi inserts a pi-mail custom message
    B->>B: Deliver as steer and trigger a turn
    Note right of B: The Agent is alerted immediately; the mail is still peer-session mail
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

Pi exposes one `mail` tool. Detailed usage guidance lives in the bundled `pi-mail` skill, keeping the tool definition compact.

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

Peer mail is quiet by default. With `notify: true`, the recipient's Pi process inserts a `pi-mail` custom message, delivers it as `steer`, and triggers a turn. This immediately alerts direct `To` recipients; `Cc` recipients remain quiet.

```text
mail {
  action: "send",
  to: ["reviewer"],
  subject: "Review needed now",
  body: "Please check the compatibility regression.",
  notify: true
}
```

Routine mailbox work is asynchronous. Inbox listings and thread views use bounded previews; a specific message can be opened in full. `wait` provides a finite, non-consuming wait for new or already-pending mail when a reply is expected:

```text
mail { action: "inbox", unpresented_only: true }
mail { action: "wait", timeout_seconds: 60 }
```

If a recipient is inactive, delivery still succeeds as long as that mailbox exists. The sender is told that the recipient is currently inactive, and the message remains waiting until that Pi session resumes.

Mail from another Pi session is clearly marked as peer-session mail and must not be treated as user authorization. Messages sent through the Web UI enter Pi as genuine user messages.

## User experience

Pi Mail also gives the user a project-wide mailbox view.

```text
/mail-ui
/mail-ui close

/mail-reminder 30
/mail-reminder off
```

`/mail-ui` starts a token-protected server bound to `127.0.0.1` and opens the local Web UI. The interface supports English and Chinese, light and dark themes, and shows each mailbox with its Pi session name, alias, short ID, active state, pending `To` / `Cc` counts, and the age of the oldest pending direct message.

From the Web UI, the user can read project mail and compose a message to one session, several sessions, or all currently active sessions. Inactive historical mailboxes can also be deleted manually when they are no longer useful. Deleting a mailbox removes that session's recipient state without rewriting shared messages that still belong to other participants.

The Web UI is optional: mail delivery continues while it is closed. Its local server stops automatically when the Pi session that opened it shuts down; `/mail-ui close` and the page close action stop it manually.

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

## Runtime showcase

A minimal two-session flow looks like this. The aliases below are illustrative; use the names returned by `discover` in your project.

Session A discovers Session B and sends a quiet peer message:

```text
mail { action: "discover" }
# 1 session:
# - reviewer (8ea109ceb705) · active

mail {
  action: "send",
  to: ["reviewer"],
  subject: "Review request",
  body: "Please review the storage changes."
}
# Sent [2ece9830] "Review request" to reviewer (8ea109ceb705).
```

Session B receives the message without an interrupt. Pi shows the pending count in its footer, and the session can inspect and answer it:

```text
# Pi footer: mail 1
mail { action: "inbox", unpresented_only: true }
# 1 inbox message:
# [2ece9830] Review request · session-... (8ea109ceb705) · TO
# Please review the storage changes.

mail {
  action: "send",
  reply_to: "2ece9830",
  body: "Reviewed. The storage changes look compatible."
}
```

These screenshots come from one live run. Session IDs, timestamps, and message IDs will differ between runs.

![Pi Mail backlog notice and inbox](./assets/notice.jpg)

*Backlog notice after three quiet direct messages. The notice reports only the count; use `inbox` to inspect message previews.*

![Pi Mail wait showcase](./assets/wait.jpg)

*Finite `wait` returns when a new message arrives without consuming it. Use `inbox` with `message_id` to open the full message.*

For a human-side view, run `/mail-ui` in either active Pi session. The page brings together project status, recent messages, session presence, pending `To` / `Cc` counts, and a **Compose as user** form. Messages sent from this form enter the target Pi session as genuine user messages; `/mail-ui close` stops the local server.

![Pi Mail Web UI showcase](./assets/web-ui.jpg)

*Project status, recent messages, user-origin composition, and session mailboxes in one page.*

To demonstrate immediate attention instead, repeat the send with `notify: true`:

```text
mail {
  action: "send",
  to: ["reviewer"],
  subject: "Review needed now",
  body: "Please check the compatibility regression.",
  notify: true
}
# Immediate notification requested for direct To recipients.
```

![Pi Mail notify runtime showcase](./assets/notify.jpg)

*With `notify: true`, the recipient Pi process inserts a peer-labeled custom message, delivers it as `steer`, and triggers a turn.*

## Development and reference

```bash
npm test
npm run pack:check
```

The bundled [`pi-mail` skill](./skills/pi-mail/SKILL.md) contains the detailed model-facing usage conventions. [`extensions/pi-mail/SPEC.md`](./extensions/pi-mail/SPEC.md) records the compatibility and maintenance contracts that future implementation changes must preserve.

## License

GPL-3.0-only. Copyright (c) frostime.
