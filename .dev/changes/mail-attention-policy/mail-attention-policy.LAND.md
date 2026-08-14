# Pi Mail Attention Policy — Code Shape

Status: contracts shaped in final code locations; implementation bodies pending

Companion requirements: `mail-attention-policy.SPEC.md`

## Narrative

The change will extract attention behavior from the extension entry point into one session-scoped runtime backed by a pure policy module. The runtime will own Pi lifecycle and delivery effects; the policy will own classification and trigger decisions; the mailbox service will retain durable mail and mailbox override persistence. A small read-only settings adapter will supply the global/project default.

This shape is intentionally narrower than a MailService rewrite. It addresses the current change-amplification point—polling, reminder rules, Pi dispatch, and suppression state sharing one closure—without introducing a generic event pipeline or notification framework.

The main flow after the change is:

```text
Pi session startup
  → read default reminder
  → initialize mailbox and decode its override
  → create one AttentionRuntime
  → reconcile durable Pi history receipts
  → start polling

AttentionRuntime check
  → reconcile newly durable Pi history receipts
  → read complete unpresented mailbox state
  → evaluate pure AttentionPolicy
  → update passive status
  → dispatch human mail and urgent bodies
  → emit an eligible quiet nudge only while Pi is idle

Pi session shutdown
  → stop and invalidate AttentionRuntime
  → close mailbox service
```

## Decision-Bearing File Tree

Magnitudes are rough drift indicators, not line budgets.

```text
extensions/pi-mail/
├── index.ts                         modify · ~25–35% reorganized
│   Composition root plus thin adapters: register Pi lifecycle, command, Web
│   UI, and mail tool; construct and dispose MailService + AttentionRuntime.
│   Existing mail action routing remains here, but no attention classification,
│   trigger decision, accepted-send state, or Pi attention dispatch remains here.
│
├── attention-policy.ts              modify · major · +90–150/-20–35
│   Own the ReminderPolicy discriminated union, public-value normalization,
│   mail classification, eligibility, oldest-first cohort selection, and pure
│   snapshot → AttentionPlan evaluation. Replace count buckets and isolated
│   stale predicates with one coherent quiet-mail decision.
│
├── attention-runtime.ts             create · +180–260
│   Deep session-scoped owner of polling, `agent_settled` rechecks, lifecycle
│   invalidation, accepted-send IDs, Pi history receipt reconstruction, footer
│   updates, urgent delivery, idle-only quiet follow-up nudges, and presentation
│   reconciliation. Expose start, stop, recheck, onAgentSettled, and status.
│
├── reminder-settings.ts             create · +60–100
│   Read namespace `ext::pi-mail`, field `reminder`, from Pi global/project
│   settings for active ctx.cwd; honor ctx.isProjectTrusted(), validate scopes
│   independently, report one warning per invalid scope/runtime, and return the
│   inherited default plus source. Never write settings.
│
├── peer-record.ts                   create · +60–100
│   Permanent storage-boundary decoder for legacy/current PeerRecord versions.
│   Convert legacy reminder state into the canonical current record without
│   leaking compatibility conditionals into service, UI, or policy code.
│
├── types.ts                         modify · minor/moderate · +35–60/-10–20
│   Declare stored PeerRecord versions, current canonical peer shape, reminder
│   override, and canonical status projection (`mode`, optional `minutes`, and
│   `source`). Keep policy implementation and legacy tool-result decoding out.
│
├── fs-store.ts                      modify · minor · +15–30/-0–10
│   Decode peers at get/list boundaries and write only current records. Generic
│   message, delivery, presence, and atomic-write behavior stays unchanged.
│
├── mail-service.ts                  modify · moderate · +60–100/-35–70
│   Persist/clear mailbox reminder overrides, resolve effective policy against
│   a supplied default, provide a complete unpresented view for Attention, and
│   keep presentation writes explicit. Remove stale-reminder decision logic.
│   Correct bounded inbox presentation ordering and new delivery timestamps.
│
├── tool-presentation.ts             modify · minor · +20–40/-5–15
│   Own the presentation-boundary decoder for restored legacy status details,
│   then render the canonical effective reminder value/source. It is the only
│   downstream location permitted to inspect legacy `reminderAfterMinutes`.
│
├── web-ui.ts                        modify · minor · +10–25/-0–10
│   Pass effective reminder status through the existing local API without
│   teaching the server Attention rules.
│
└── web/index.html                   modify · minor · ~5–10%
    Display off/after-turn/minutes and inherited/override source in both
    languages; preserve current read-only mailbox observation behavior.

test/
├── attention-policy.test.ts         create · +140–220
│   Behavior-oriented coverage of classification, clean off, idle/age plans,
│   exclusions, cohort selection, and effective policy values.
│
├── attention-runtime.test.ts        create · +180–280
│   Contract-level fake-host coverage for accepted-send suppression before
│   durable history, receipt restoration, idle timing, lifecycle invalidation,
│   footer behavior, and no presentedAt mutation from nudges.
│
├── mail-service.test.ts             modify · moderate · +100–170/-20–50
│   Peer-record compatibility, override/default precedence, explicit off,
│   clearing to inherit, complete Attention scans, bounded inbox presentation,
│   and delivery-time semantics. Preserve all existing mail protocol tests.
│
└── web-ui.test.ts                   modify · minor · +15–35/-5–15
    Assert the new reminder status projection and bilingual UI support.

documentation and release surface
├── extensions/pi-mail/SPEC.md       modify · attention sections
│   Replace count-triggered activation and stale-only policy with the accepted
│   recipient-owned Attention contract and compatibility rules.
├── README.md                        modify · reminder/attention sections
├── README.zh-CN.md                  modify · mirrored behavior
├── CHANGELOG.md                     modify · Unreleased entry
├── package.json                     modify · Pi peer minimum `>=0.80.4`
└── skills/pi-mail/SKILL.md          inspect, modify only if existing guidance
    would otherwise imply count-triggered activation or old command semantics.
```

## Cross-Module Ownership and Dependency Direction

### Before

```text
index.ts
  → MailService
  → scattered pure helpers
  → Pi APIs
  → multiple in-memory reminder latches

MailService
  → reminder normalization helper
  → peer persistence
```

The entry point must understand storage-derived mail classification, two reminder state machines, Pi timing, and presentation reconciliation at once.

### After

```text
index.ts
  → reminder-settings
  → MailService
  → AttentionRuntime

AttentionRuntime
  → AttentionPolicy
  → MailService intent-level queries/updates
  → Pi APIs

MailService
  → canonical reminder types
  → FsMailStore

FsMailStore
  → peer-record decoder
```

Rules:

1. `attention-policy.ts` has no dependency on Pi APIs, timers, filesystem storage, or settings files.
2. `attention-runtime.ts` may depend on Pi APIs and MailService, but MailService must not depend on the runtime.
3. Peer schema compatibility is decoded once at the storage boundary. No downstream module checks both `reminderAfterMinutes` and the current reminder representation; restored legacy tool-result details are a separate presentation-only exception owned by `tool-presentation.ts`.
4. Settings defaults remain process configuration. They are supplied to mailbox policy resolution and are not written into an inheriting peer record.
5. MailService is the sole effective-policy/source resolver. AttentionRuntime delegates status to it; UI and tool presentation consume the canonical result and do not reconstruct precedence or reminder meaning.
6. `presentedAt` is updated only by explicit presentation operations. Nudge dispatch never calls those operations.

## Core Contracts to Embed During Shaping

These contracts should be introduced at final code locations before implementation bodies are filled in.

### Reminder domain

The policy module must make these distinctions unrepresentable as accidental `null` conventions:

```text
ReminderPolicy:
  off | after-turn | after-minutes(minutes)

MailboxReminderOverride:
  absent/inherit | explicit ReminderPolicy

EffectiveReminderPolicy:
  policy + source(mailbox/project/global/built-in)
```

JSON/settings/command scalar values are decoded at boundaries. Internal callers use named variants.

### Attention evaluation

One pure operation accepts:

- all relevant unpresented deliveries, not a display-limited page;
- the effective reminder policy;
- Pi idle/busy state;
- current time;
- IDs already durably nudged or accepted for send.

It returns a plan containing:

- passive pending count;
- human and urgent peer messages eligible for their authority-specific delivery;
- at most one oldest-first quiet cohort with `after-turn` or `age` reason;
- total quiet pending count separately from the newly covered cohort IDs.

The runtime dispatch order is human-origin mail, urgent peer bodies, then an idle-only quiet nudge.

The plan contains no Pi callbacks and performs no state mutation.

### Runtime lifecycle

One runtime instance belongs to one started Pi session context and captures only that session's service/context. `stop()` invalidates its generation, clears timers/footer, and waits for outstanding checks before MailService closes. Results from a stopped or superseded generation are discarded before any Pi, footer, presence, or presentation side effect.

While Pi is busy, the runtime records only that a settled recheck is needed; it does not call `sendMessage`. `index.ts` forwards `agent_settled` to the current runtime, which re-reads policy and mailbox state. This makes a policy change to `off` cancellative until dispatch.

Immediately before an idle dispatch, the runtime records cohort IDs as accepted for send. IDs become durable suppression receipts only after `pi-mail-nudge` details appear anywhere in the current Pi session entries. Accepted IDs remain suppressed until matching history appears or the runtime stops; the design relies on Pi's accepted `sendMessage` queue and intentionally adds no retry timer.

### Peer compatibility

The peer decoder accepts legacy v1 and current v2 records and returns one canonical current shape. Current v2 uses optional field `reminder`: absent means inherit; `"off"`, `"after-turn"`, or integer 1–1440 are the only valid present values. `null`, malformed values, a v2 record carrying the legacy `reminderAfterMinutes` field, and unknown versions fail with an identifying error.

The deterministic legacy mapping is:

```text
v1 reminderAfterMinutes = integer 1–1440 → explicit after-minutes override
v1 reminderAfterMinutes absent/null/0    → explicit off override
other legacy value                       → identifying decode error
```

Current writes use `version: 2` and never emit `reminderAfterMinutes`.

### Inbox presentation

Display paging and presentation mutation follow this order:

```text
select eligible deliveries
→ sort
→ apply requested limit
→ load returned messages
→ mark only returned recipient deliveries presented
```

Attention scanning uses a separate complete query and never relies on a bounded display page.

## High-Impact Logic Shape

### Startup and effective default

1. On supported Pi `>=0.80.4`, read global and, when `ctx.isProjectTrusted()`, project settings through `SettingsManager` for active `ctx.cwd`.
2. Read namespace `ext::pi-mail`, field `reminder`; validate each scope independently and emit at most one warning per invalid scope/runtime.
3. Project invalidity does not erase a valid global default. Linked worktrees may resolve different runtime defaults even though they share the canonical mail store.
4. Cross-mailbox views must not apply the observer's runtime default to another inheriting mailbox. `MailboxOverview.reminder` is canonical for self and explicit peer overrides, and `null` for a non-self peer without an override; this null is observation uncertainty rather than a policy mode.
5. Initialize MailService with the resolved inherited default and its source.
6. Decode/migrate the current peer record and resolve mailbox override precedence.
7. Construct AttentionRuntime, reconcile all current session entries, then start polling only after MailService initialization succeeds.

### Quiet nudge decision

```text
eligible quiet = unpresented peer-session direct To
                 AND notify is false
                 AND not already durably nudged
                 AND not already accepted for send

policy off:
  no quiet cohort

policy after-turn:
  if busy, request an agent-settled recheck without queuing a Pi message
  if idle, choose all eligible IDs in oldest-first snapshot order

policy after-minutes:
  choose no cohort until the oldest eligible delivery is overdue
  if overdue but busy, request an agent-settled recheck
  if overdue and idle, choose all eligible IDs in oldest-first snapshot order

nudge details:
  messageIds = newly covered cohort only
  pendingCount = total quiet-direct pending count
  reason = after-turn | age
```

Deliveries arriving after the evaluated snapshot form a later cohort. A previously covered ID is excluded from later cohort IDs even if it remains unpresented, although it still contributes to `pendingCount`.

### Removal of count activation

Delete the threshold bucket and its runtime state. No replacement count-trigger path is introduced. Pending count remains an output for footer and Web UI only.

### Command updates

The no-argument branch is a read-only presentation path: fetch canonical effective status, format one user-facing status line plus concise usage/settings-default help, then return without persistence, runtime recheck, or the one-time hint.

Mutating arguments delegate value parsing to the reminder boundary and mailbox persistence to MailService. After a successful change, the command asks the runtime to recheck. The one-time settings hint is presentation-only state owned by the loaded extension/runtime, not a field in PeerRecord.

## Compatibility and Migration Shape

- Do not migrate message or delivery files.
- Decode inactive legacy peers lazily; do not perform a project-wide rewrite.
- Rewriting the current peer during normal initialization is acceptable because initialization already updates that record.
- Keep restored old tool-result rendering tolerant of `reminderAfterMinutes` at the presentation boundary; validate canonical and legacy minute values through the same 1–1440 bounds and fall back safely for malformed historical details.
- Ignore old count/stale custom messages as cohort receipts because they lack complete message IDs.
- Document that downgrade may collapse any v2 inheritance/minute/after-turn state to old absent/off when an old version rewrites the peer, while canonical mail remains readable.

A generic migration registry is deliberately excluded. If another peer schema version is introduced later, extend the same decoder with an explicit version branch.

## Verification Shape

Tests should protect behavior rather than internal function count or private field names.

Highest-value contracts:

1. `off` never starts a quiet-mail turn regardless of count.
2. mailbox override and default-source precedence are truthful, while non-self inherited mailbox overviews remain explicitly unobservable (`null`) rather than borrowing the observer's default.
3. quiet nudge and presentation are independent.
4. the same cohort is suppressed before and after reload.
5. new mail can form a later cohort.
6. runtime shutdown/reload/fork replacement prevents stale-session side effects.
7. changing policy to off while busy cancels the deferred settled check before dispatch.
8. human, urgent peer, and quiet lanes dispatch in authority order.
9. a bounded inbox read cannot silently present omitted mail.
10. legacy peer ambiguity migrates conservatively to explicit off, while malformed/unknown records fail clearly.
11. all existing durable mail and addressing behavior remains compatible.

Expected verification commands:

```text
npm test
npm run pack:check
```

A TUI smoke check should cover global default, trusted project override, mailbox `default`, `off`, `after-turn`, minute policy, no-argument status/help with no side effects, source display, and the one-time settings hint on mutation only.

## Drift Triggers

Stop and return for architecture review if implementation requires any of the following:

- changing canonical MessageRecord or DeliveryRecord schema for nudge state;
- a durable attention event log or cross-process lease;
- MailService calling Pi APIs;
- policy code reading settings or storage directly;
- preserving automatic count-triggered model turns;
- more than one stateful owner deciding quiet-mail eligibility;
- a generic migration framework;
- a new public recipient policy for urgent `notify` behavior;
- a broad MailService rewrite unrelated to Attention or presentation correctness.

Peripheral documentation or fixture files discovered during implementation do not constitute drift when they only propagate the accepted contract.

## Pinned Implementation Direction

Implementation must preserve these reviewed spatial decisions:

1. Attention policy is pure and separate from the Pi runtime.
2. One session-scoped AttentionRuntime owns all attention state and Pi effects.
3. MailService retains mailbox override persistence but not trigger decisions.
4. Legacy peers use a centralized v1 → v2 decoder, with absent legacy reminder mapped to explicit off.
5. Count-triggered model turns are removed rather than represented as another reminder mode.

A materially different owner, dependency direction, persistence model, or lifecycle boundary is design drift and requires review before implementation continues.
