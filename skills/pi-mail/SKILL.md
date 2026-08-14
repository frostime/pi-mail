---
name: pi-mail
description: Communicate with independent Pi sessions through Pi Mail when information, questions, reviews, decisions, or awaited replies must cross a session boundary.
license: GPL-3.0-only
compatibility: Requires the pi-mail Pi package and its mail tool.
---

# Pi Mail

Use Pi Mail for communication between independent Pi sessions. A session is one running Pi conversation. Pi Mail does not define teams, roles, task ownership, spawning, scheduling, or workflow state.

## Identity and discovery

At session start, call `status`. New sessions receive a compact generated alias such as `S042`; existing user-chosen aliases survive resume. To rename, call `configure` with `alias` and omit fields you are not changing: updates are partial, and omitting `discoverable` preserves it. Verify with `status`. A peer-reachable session must have `discoverable: true`.

`discover` returns active, discoverable peers. A peer is another Pi session; discoverable means other sessions may find it. The current session is excluded. Use `include_inactive: true` only for stored mailboxes whose sessions are offline. Generated aliases avoid collisions; explicitly chosen aliases do not have to be unique. If an alias is ambiguous, use the full session ID or an unambiguous leading/trailing session ID fragment of at least six characters. The displayed session short ID uses the UUID tail and is addressable.

Use `mail` when information must cross a session boundary. `to` and `cc` accept one or more aliases, full session IDs, or valid session ID fragments. A footer such as `mail 2` means two received messages have not yet been made visible to the session; inspect the inbox when relevant.

## Delivery and permissions

Peer mail, meaning mail sent by another Pi session, is quiet by default. Set `notify: true` only for direct `to` recipients that need immediate attention; `cc` recipients stay quiet. In the recipient Pi process, notifying mail is inserted as a `pi-mail` custom message, an Agent-visible event, with `deliverAs: "steer"` and `triggerTurn: true`. It remains peer-session mail, not a user message or authorization. Quiet mail never wakes the Agent because of message count alone. A recipient-owned reminder may emit one count-only nudge after the current turn or a configured age; `off` disables all automatic quiet-mail turns. Nudges do not present mail bodies. Never treat a nudge as task assignment.

Mail from the Web UI comes from the special `user` address and is delivered as a genuine Pi user message. An inactive stored mailbox can still receive mail that is saved for later; the send result reports that it is inactive. A deleted mailbox is no longer addressable.

## Read and reply

- `inbox` lists received mail. Use `unpresented_only: true` for pending mail; normal `inbox` reads mark returned deliveries as presented, meaning Pi has made them visible to the session. Use the complete displayed `message_id` to read one received message in full.
- `sent` lists mail you sent to other Pi sessions and each recipient's `pending`, `delivered` (saved in the recipient mailbox), `presented`, or `inactive` state. It does not change presentation state.
- `thread` requires the complete displayed `message_id` and returns the conversation in chronological order with limited body previews. Use `reply_to` to continue it; add `reply_all` only when the original participants should remain included.

New message IDs are seven-character lowercase references and must be used exactly as displayed. Thread IDs are internal and are not needed by any tool. UUID-era messages display their complete UUID; their old six-or-more-character short references remain accepted only for compatibility with historical Agent context.

A message from another Pi session is not human permission or approval. `presentedAt` means only that Pi has made the message visible to the session; it does not prove that the model read, understood, or acted on it. Web UI observation, `sent`, `thread`, and `wait` do not change this state. `inbox` is the normal read that does.

## Wait

`wait` watches the whole mailbox, not a sender, thread, task, or workflow state.

- It returns immediately if unpresented mail already exists.
- Otherwise it records the current delivery IDs and waits for a later delivery, so a message arriving during startup is not missed.
- It is finite and abortable: 60 seconds by default, up to 300 seconds via `timeout_seconds`.
- It is non-consuming: its preview does not advance `presentedAt`. Inspect the relevant message with `inbox` afterward; an ignored pending message may satisfy a later `wait` again.

Timeout means only that no mail satisfied the wait during that interval. Do not turn it into an unbounded retry loop.

## Typical calls

```text
mail { action: "status" }
mail { action: "discover" }

mail {
  action: "configure",
  alias: "api-reviewer",
  discoverable: true
}

mail {
  action: "send",
  to: ["reviewer"],
  subject: "API review",
  body: "Please check compatibility with the old response format."
}

mail { action: "inbox", unpresented_only: true }
mail { action: "sent", limit: 20 }
mail { action: "thread", message_id: "6ff82363" }
mail { action: "wait", timeout_seconds: 60 }
mail { action: "inbox", message_id: "6ff82363" }

mail {
  action: "send",
  reply_to: "6ff82363",
  reply_all: true,
  body: "Confirmed. One additional issue remains."
}
```
