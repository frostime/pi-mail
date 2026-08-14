import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateAttention,
  parseReminderPolicy,
  type EffectiveReminderPolicy,
} from "../extensions/pi-mail/attention-policy.ts";
import type { MailMessage, RecipientKind, SenderKind } from "../extensions/pi-mail/types.ts";

const OFF: EffectiveReminderPolicy = { policy: { kind: "off" }, source: "built-in" };
const AFTER_TURN: EffectiveReminderPolicy = { policy: { kind: "after-turn" }, source: "mailbox" };

function mail(id: string, options: {
  senderKind?: SenderKind;
  kind?: RecipientKind;
  notify?: boolean;
  deliveredAt?: string;
  presentedAt?: string | null;
} = {}): MailMessage {
  return {
    id,
    senderKind: options.senderKind ?? "session",
    from: { id: "sender", shortId: "sender", alias: "sender" },
    to: [],
    cc: [],
    subject: id,
    body: id,
    notify: options.notify ?? false,
    threadId: id,
    inReplyTo: null,
    createdAt: options.deliveredAt ?? "2026-01-01T00:00:00.000Z",
    delivery: {
      kind: options.kind ?? "to",
      deliveredAt: options.deliveredAt ?? "2026-01-01T00:00:00.000Z",
      presentedAt: options.presentedAt ?? null,
    },
  };
}

function evaluate(overrides: Partial<Parameters<typeof evaluateAttention>[0]> = {}) {
  return evaluateAttention({
    messages: [],
    effectiveReminder: OFF,
    durablyNudgedIds: new Set(),
    acceptedSendIds: new Set(),
    idle: true,
    nowMs: Date.parse("2026-01-01T01:00:00.000Z"),
    ...overrides,
  });
}

test("reminder values decode only the public policy domain", () => {
  assert.deepEqual(parseReminderPolicy("off"), { kind: "off" });
  assert.deepEqual(parseReminderPolicy("after-turn"), { kind: "after-turn" });
  assert.deepEqual(parseReminderPolicy(30), { kind: "after-minutes", minutes: 30 });
  for (const invalid of [0, 1441, 1.5, null, "30", "later"]) {
    assert.throws(() => parseReminderPolicy(invalid));
  }
});

test("off keeps any quiet-mail count passive", () => {
  const messages = Array.from({ length: 6 }, (_, index) => mail(`m${index}`));
  const plan = evaluate({ messages, effectiveReminder: OFF });
  assert.equal(plan.pendingTo, 6);
  assert.equal(plan.quietNudge, undefined);
  assert.equal(plan.recheckWhenSettled, false);
});

test("attention lanes exclude Cc, notifying, human, and presented mail from quiet cohorts", () => {
  const messages = [
    mail("quiet"),
    mail("cc", { kind: "cc" }),
    mail("urgent", { notify: true }),
    mail("human", { senderKind: "human" }),
    mail("presented", { presentedAt: "2026-01-01T00:30:00.000Z" }),
  ];
  const plan = evaluate({ messages, effectiveReminder: AFTER_TURN });
  assert.deepEqual(plan.humanMail.map((item) => item.id), ["human"]);
  assert.deepEqual(plan.urgentPeerMail.map((item) => item.id), ["urgent"]);
  assert.deepEqual(plan.quietNudge?.messageIds, ["quiet"]);
  assert.equal(plan.quietNudge?.pendingCount, 1);
  assert.equal(plan.pendingCc, 1);
});

test("busy eligibility records only a settled recheck", () => {
  const plan = evaluate({ messages: [mail("quiet")], effectiveReminder: AFTER_TURN, idle: false });
  assert.equal(plan.quietNudge, undefined);
  assert.equal(plan.recheckWhenSettled, true);
});

test("an overdue oldest delivery covers the complete unnudged snapshot oldest-first", () => {
  const messages = [
    mail("new", { deliveredAt: "2026-01-01T00:55:00.000Z" }),
    mail("old", { deliveredAt: "2026-01-01T00:20:00.000Z" }),
    mail("nudged", { deliveredAt: "2026-01-01T00:10:00.000Z" }),
  ];
  const plan = evaluate({
    messages,
    effectiveReminder: { policy: { kind: "after-minutes", minutes: 30 }, source: "project" },
    durablyNudgedIds: new Set(["nudged"]),
  });
  assert.deepEqual(plan.quietNudge, {
    messageIds: ["old", "new"],
    pendingCount: 3,
    reason: "age",
  });
});

test("durable and accepted IDs are suppressed while later mail forms a new cohort", () => {
  const plan = evaluate({
    messages: [mail("durable"), mail("accepted"), mail("new")],
    effectiveReminder: AFTER_TURN,
    durablyNudgedIds: new Set(["durable"]),
    acceptedSendIds: new Set(["accepted"]),
  });
  assert.deepEqual(plan.quietNudge?.messageIds, ["new"]);
  assert.equal(plan.quietNudge?.pendingCount, 3);
});
