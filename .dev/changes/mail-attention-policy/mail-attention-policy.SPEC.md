# Pi Mail Attention Policy Change Specification

Status: approved for implementation handoff

## Problem Statement

Pi Mail currently has several independently implemented ways to attract attention:

- a passive `mail N` footer;
- immediate direct-mail delivery when the sender sets `notify: true`;
- an automatic count-only model turn when three quiet direct messages accumulate;
- an optional age-based `/mail-reminder` setting;
- the Agent-controlled `mail wait` operation.

These mechanisms serve different needs but are coordinated in one Pi extension runtime with separate counters and Boolean latches. The result is difficult to explain and increasingly costly to change. In particular, `/mail-reminder off` does not disable the three-message model activation, so “off” does not have a clean user-visible meaning.

The change must provide one coherent recipient-owned policy for automatic attention to quiet direct mail. It must keep durable mail asynchronous by default, preserve sender-requested urgent delivery and human-origin authority, avoid interrupting an active Agent for quiet mail, and make automatic model activation predictable and deduplicated.

Success means a user can answer all of these without knowing the implementation:

1. Which mail can start a model turn?
2. Who chose that behavior: sender, mailbox owner, project setting, or global setting?
3. When will the turn start?
4. Does a reminder mean the mail body was presented?
5. Will the same waiting mail repeatedly start turns?

## Terminology

- **Quiet direct mail**: peer-session mail delivered as `To` without `notify: true`.
- **Urgent peer mail**: peer-session direct `To` mail carrying the sender's `notify: true` urgency hint.
- **Passive indicator**: UI state such as footer `mail N`; it does not add model context or start a turn.
- **Nudge**: a count-only Pi custom message emitted at an idle boundary to start one model turn without presenting mail bodies.
- **Presented**: the mail body crossed Pi Mail's presentation boundary. It does not mean read, understood, accepted, or handled.
- **Mailbox override**: a reminder policy explicitly selected for one Pi Mail mailbox.
- **Default reminder**: the policy inherited by a mailbox with no override, resolved from trusted project settings, then global settings, then the built-in default.
- **Nudge cohort**: the oldest-first snapshot of quiet direct message IDs that have not previously been durably nudged and are covered by one new nudge receipt. Previously nudged IDs are not repeated in a later cohort.

## Approach

Introduce a cohesive Attention subsystem with three responsibilities:

1. A pure policy evaluates pending mail, the effective reminder policy, Pi idle/busy state, current time, and prior nudge receipts.
2. A session-scoped runtime owns polling, lifecycle cancellation, Pi delivery channels, footer updates, and nudge receipt reconciliation.
3. A read-only settings adapter resolves the default reminder without modifying Pi settings files.

The mailbox service remains responsible for durable mail, presentation state, `wait`, and the persisted mailbox override. It may resolve the effective policy from its override and the supplied default, but it must not decide when or how Pi starts a model turn.

The automatic three-message model activation is removed. Message count remains visible through the passive footer and Web UI, but count alone does not wake the Agent.

No generic rules engine, event bus, scheduler framework, repeated reminder schedule, read receipt, or task/handled state is introduced.

## Behavior Contract

### Attention lanes

The following behaviors are independent:

| Mail or operation | Passive indicator | Adds body to context | May start a turn | Timing |
|---|---:|---:|---:|---|
| Human-origin mail | Yes | Yes | Yes | Immediate through the user-message authority channel |
| Urgent peer direct `To` | Yes until presented | Yes | Yes | Preserve current `steer` behavior |
| Quiet peer direct `To` | Yes | No, unless explicitly opened | Only when recipient reminder policy allows | Safe `followUp` boundary |
| Peer `Cc` | Yes | No | No | Never automatically |
| `mail wait` result | No extra automatic effect | Preview only | Controlled by the calling Agent | Finite, abortable wait |
| Web UI observation | Yes | No model context | No | Read-only |

The sender's `notify` value remains an urgency hint in the mail protocol. The recipient-side Attention subsystem owns the mapping from that hint to Pi behavior. This change preserves the existing immediate mapping; it does not add a recipient configuration surface for urgent mail.

### Quiet reminder policies

The public reminder value accepts:

- `"off"`: quiet mail never starts a model turn automatically;
- `"after-turn"`: quiet mail produces one count-only nudge after the current Agent run settles; if Pi is already idle, the nudge starts immediately;
- an integer from 1 through 1440: quiet mail becomes eligible after the oldest eligible delivery has waited that many minutes; if Pi is busy at that deadline, delivery waits until the Agent run settles.

Internally these values must be represented by a named discriminated policy type rather than mixed primitive values or overloaded `null`.

A quiet nudge:

- applies only to unpresented quiet direct `To` mail;
- is emitted only while Pi is idle, using `deliverAs: "followUp"` with `triggerTurn: true`, and never uses `steer`;
- contains the total current quiet-direct pending count and guidance to inspect the inbox, but no mail body;
- does not advance `presentedAt`;
- records only the newly covered, previously unnudged cohort IDs in custom-message details;
- is emitted at most once for each covered ID after its custom message is durable in Pi session history;
- may cover a later cohort when new quiet direct mail arrives while older, already nudged mail remains unpresented.

The custom message uses `customType: "pi-mail-nudge"` and details shaped as `{ messageIds: string[], pendingCount: number, reason: "after-turn" | "age" }`. Cohort IDs are selected oldest-first from one complete mailbox snapshot. New deliveries after that snapshot wait for a later evaluation. For an age trigger, once the oldest previously unnudged delivery is overdue, the cohort covers all currently unnudged quiet direct deliveries in that snapshot; `pendingCount` still reports all quiet direct mail waiting, including older already nudged mail.

The runtime reconciles durable receipts from all entries in the current Pi session before its first evaluation and before dispatching a new nudge. Compaction and tree navigation do not erase the underlying session entries used for this reconciliation. In-process accepted-send IDs suppress duplicate sends from API acceptance until matching history appears or the runtime stops; Pi's accepted `sendMessage` queue is relied upon rather than adding a speculative retry timer. On reload or resume, durable nudge details reconstruct suppression state. Exactly-once behavior across two concurrently active Pi runtimes sharing one mailbox is not guaranteed by this change; durable mail itself remains safe.

### Clean `off` semantics

When the effective reminder is `off`:

- quiet direct mail does not start a model turn because of age, count, or Agent lifecycle;
- changing the effective policy to `off` before a deferred busy-session check reaches `agent_settled` prevents that nudge because no Pi follow-up is queued while the Agent is busy;
- the previous three-message and threshold-bucket model activations do not occur;
- the footer and Web UI may still show pending counts;
- urgent peer mail and human-origin mail retain their independent behavior;
- an Agent may still inspect the inbox or call `wait` explicitly.

### Default and override precedence

The effective reminder is resolved in this order:

1. mailbox override;
2. trusted project `npm:pi-mail.reminder` default;
3. global `npm:pi-mail.reminder` default;
4. built-in `off`.

The settings value is a default only. It is not copied into an unconfigured mailbox record. A later settings change therefore affects an inheriting mailbox on the next Pi startup or reload.

A mailbox must distinguish these states:

- no override: inherit the resolved default;
- explicit `off`: ignore the default and stay off;
- explicit `after-turn` or minute policy: ignore the default and use the override.

Settings use namespace `npm:pi-mail` and field `reminder`. Global settings are read from Pi's agent settings. Project settings are resolved by Pi's `SettingsManager` from the active `ctx.cwd`, not from Pi Mail's canonical shared Git mail root, and are honored only when `ctx.isProjectTrusted()` is true. This intentionally allows linked worktrees that share a mailbox store to supply different runtime defaults; a persisted mailbox override remains shared and wins in every worktree.

An invalid project value is ignored and resolution continues to the valid global value or built-in default. An invalid global value is ignored. Each invalid scope produces at most one `console.warn` per loaded runtime and, when `ctx.hasUI`, one TUI warning during startup; poll checks never repeat the warning. Pi Mail never writes either settings file.

Examples:

```json
{
  "npm:pi-mail": {
    "reminder": 30
  }
}
```

```json
{
  "npm:pi-mail": {
    "reminder": "after-turn"
  }
}
```

```json
{
  "npm:pi-mail": {
    "reminder": "off"
  }
}
```

### Command behavior

The command surface becomes:

```text
/mail-reminder
/mail-reminder off
/mail-reminder after-turn
/mail-reminder <1-1440>
/mail-reminder default
```

- No argument is read-only: it prints one user-facing status plus concise help text. It does not modify configuration, re-evaluate pending mail, or emit the one-time settings hint.
- The status identifies the effective policy and source; the help lists `off`, `after-turn`, `<1-1440>`, and `default`, and briefly identifies `npm:pi-mail.reminder` as the settings default.
- `off`, `after-turn`, and a minute value persist a mailbox override.
- `default` removes the mailbox override and restores inheritance.
- A successful change causes the Attention runtime to re-evaluate pending mail. When Pi is busy, the runtime waits for `agent_settled` and re-reads the then-current effective policy rather than pre-queuing a follow-up; therefore a later `off` or `default` command can cancel a not-yet-emitted nudge.
- When the command changes a reminder for the first time in a loaded session and neither settings scope defines a valid default, the TUI shows one additional hint explaining `npm:pi-mail.reminder`. This hint is informational and is not persisted as mailbox protocol data.

Example no-argument output:

```text
Pi Mail reminder: 30 minutes (project default).
Usage: /mail-reminder off|after-turn|<1-1440>|default
Default for unconfigured mailboxes: npm:pi-mail.reminder in Pi settings.
```

The first line may instead report `off (mailbox override)` or `after current turn (global default)` as applicable.

### Presentation and receipt semantics

`deliveredAt`, nudge receipt, and `presentedAt` are distinct:

- `deliveredAt`: the durable recipient delivery record was created;
- nudge receipt: Pi durably stored a count-only attention message covering specified IDs;
- `presentedAt`: a specific mail body crossed the presentation boundary.

A nudge must never mark a delivery presented. Opening a bounded inbox page may mark only the deliveries actually returned in that page; records beyond the returned limit must remain unpresented.

New delivery records use the time the recipient delivery record is created for `deliveredAt`. Existing timestamps remain readable and are not rewritten.

### Compatibility

Existing canonical messages and delivery records remain readable without migration. Existing compatibility rules for missing `senderKind`, missing `notify`, legacy message IDs, aliases, and tombstoned peers remain unchanged.

Reminder configuration moves to a new peer-record representation with a centralized version decoder. All non-reminder peer fields retain their v1 meaning. The canonical v2 JSON field is optional `reminder`; it is absent for inheritance, the string `"off"` for an explicit off override, the string `"after-turn"` for that override, or an integer from 1 through 1440 for an age override. `null`, non-integers, out-of-range numbers, and other strings are never written. The following JSON objects are reminder fragments; normal peer identity fields are omitted for brevity.

```json
{ "version": 2, "reminder": "off" }
```

```json
{ "version": 2, "reminder": "after-turn" }
```

```json
{ "version": 2, "reminder": 30 }
```

A v2 record with no `reminder` field inherits its runtime default. A v2 record that contains the legacy `reminderAfterMinutes` field, a malformed v2 reminder, or an unknown peer-record version fails peer decoding with a path/peer-specific error; this change does not silently repair corrupted, mixed-version, or forward-version data.

Legacy v1 decoding is deterministic:

- a positive integer `reminderAfterMinutes` from 1 through 1440 becomes an explicit minute override;
- absent, `null`, or `0` legacy reminder state becomes an explicit `off` override;
- any other legacy reminder value fails decoding rather than being guessed;
- current writes use peer-record version 2 and never emit `reminderAfterMinutes`;
- inactive legacy peers are decoded on read and need not be rewritten eagerly;
- initialization of the current mailbox may lazily rewrite its peer record in the current format.

Mapping an ambiguous legacy absence to explicit `off` is intentional: an upgrade must not silently enable automatic model turns for an existing mailbox. The user can run `/mail-reminder default` to opt that mailbox into inherited settings.

Old `pi-mail-notice` and `pi-mail-reminder` custom messages remain displayable session history. Because they do not carry a complete cohort of message IDs, they are not treated as new-format nudge receipts.

Upgrade compatibility is required. Downgrading to an older Pi Mail version is not guaranteed to preserve any v2 reminder state: inheritance or a minute/after-turn override may collapse to the old implementation's absent/off representation when that version rewrites the peer. Downgrade must not make canonical messages or delivery records unreadable.

## Implementation Decisions

### Domain model

Use an explicit reminder policy union with `off`, `after-turn`, and `after-minutes` variants. Represent inheritance separately from `off`. Effective policy reporting includes both the policy and its source.

The persisted peer record stores only a mailbox override. Settings defaults are process configuration and do not become mailbox data unless the user explicitly selects an override.

### Ownership

The pure Attention policy owns:

- classification of urgent and quiet direct mail;
- reminder eligibility;
- age and idle trigger rules;
- exclusion of human mail, `Cc`, notifying mail, and presented mail from quiet nudges;
- construction of one decision plan with an explicit reason.

The session-scoped Attention runtime owns:

- polling and the `agent_settled` recheck boundary; `turn_end` and `agent_end` are not completion boundaries for quiet nudges;
- in-flight generation or cancellation guards;
- temporary accepted-send IDs;
- reconstruction of durable nudge receipts from Pi history;
- footer updates;
- Pi `steer`, `followUp`, and user-message calls;
- reconciliation of urgent mail presentation after durable history appears.

The mailbox service owns:

- stored peer override and compatibility migration;
- durable messages, delivery records, presentation updates, and inbox queries;
- effective-policy resolution from a supplied default and the mailbox override;
- a complete, read-only view of unpresented deliveries for Attention evaluation.

### Main flow and lifecycle

The extension entry point is a composition root plus thin command/tool/Web UI adapters. Each `session_start` constructs a fresh runtime identity whose callbacks capture only that session's service and context. Before replacement or reload binds another runtime, `session_shutdown` awaits `stop()`, invalidates the old generation, clears timers and footer state, then closes that captured service. A stopped or superseded runtime must discard in-flight results before updating footer, presence, presentation state, or Pi messages.

Attention evaluation must inspect the complete unpresented mailbox rather than a bounded display page so that a newer urgent message cannot be hidden behind an old backlog. Display-oriented inbox limits remain bounded.

### Observability

An effective reminder status has one canonical public projection: `{ mode: "off" | "after-turn" | "after-minutes", minutes?: number, source: "mailbox" | "project" | "global" | "built-in" }`; `minutes` is present only for `after-minutes`. Current-mailbox tool details, TUI text, the Web API, and Web UI consume this projection. Cross-mailbox observation is intentionally nullable: `MailboxOverview.reminder` is the canonical status for self and for another mailbox with an explicit override, but `null` for a non-self inheriting mailbox because linked worktrees may resolve different trusted project/global defaults and the observer cannot know that runtime-local effective value. `null` is observation uncertainty, not a reminder policy state. A presentation-boundary decoder may translate restored legacy tool-result details containing `reminderAfterMinutes`; no other downstream module reads that legacy field.

Attention decisions carry a reason and relevant message IDs in structured details. Errors continue to use the extension's existing error logging style; invalid settings produce bounded startup warnings rather than repeated poll-loop errors.

## Acceptance Criteria

### Automated behavior

1. With no mailbox override and no valid settings value, the effective reminder is `off`.
2. Project default overrides global default only for a trusted project.
3. Explicit mailbox `off` overrides project and global defaults.
4. Removing the mailbox override restores inheritance.
5. Invalid settings values are ignored and reported once without preventing Pi Mail startup.
6. With effective `off`, one, three, six, or more quiet direct messages never enqueue a model-triggering nudge.
7. Footer and Web UI pending counts remain visible while reminder is off and do not mutate presentation state.
8. `after-turn` records a settled recheck while busy without queuing a Pi message, then emits at most one count-only nudge for the eligible cohort when idle.
9. A minute policy nudges only after the oldest eligible quiet direct delivery reaches the configured age.
10. Quiet nudges exclude `Cc`, human mail, `notify: true` mail, and presented deliveries.
11. A nudge does not advance `presentedAt`.
12. Reload reconstructs nudge receipts from session history and does not repeat the same cohort.
13. New quiet mail can form a later cohort even when older nudged mail remains unpresented.
14. Existing urgent peer and human-origin delivery behavior remains operational.
15. A bounded inbox read marks only returned deliveries presented.
16. Attention scanning considers all unpresented deliveries, including urgent mail beyond normal display limits.
17. New `deliveredAt` values represent recipient delivery-record creation time.
18. Legacy peer records with a minute value decode to the equivalent minute override.
19. Legacy peer records without a minute value decode to explicit `off`.
20. Existing message, delivery, alias, ID, tombstone, and missing-field compatibility tests continue to pass.
21. Changing an age/after-turn policy to `off` while Pi is busy prevents the deferred nudge at `agent_settled`.
22. Human mail is dispatched first, urgent peer bodies second, and a quiet nudge last when one scan contains multiple attention lanes.
23. Unknown peer versions and malformed current or legacy reminder values fail with an identifying error rather than silent repair.
24. The complete repository test suite and package dry-run pass.

### User-visible verification

1. `/mail-reminder` with no argument prints only user-facing status and concise help: the effective `off`, `after current turn`, or minute value; its `mailbox override`, `project default`, `global default`, or `built-in default` source; accepted command values; and the settings-default key. It causes no configuration or Attention side effect.
2. `/mail-reminder default` visibly changes the source back to the applicable inherited default.
3. The README documents global and project examples, precedence, trusted-project behavior, and all command values.
4. The first relevant command change in a loaded session shows the settings hint only once when no valid default exists.
5. Release notes and the module maintenance specification explicitly describe removal of automatic count-triggered model turns and the clean `off` guarantee.
6. The package declares `@earendil-works/pi-coding-agent >=0.80.4`, the verified minimum for the settled lifecycle semantics required by Attention.
