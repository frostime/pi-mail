import type { MailMessage } from "./types.ts";

export type ReminderPolicy =
  | { kind: "off" }
  | { kind: "after-turn" }
  | { kind: "after-minutes"; minutes: number };

export type ReminderSource = "mailbox" | "project" | "global" | "built-in";

export interface EffectiveReminderPolicy {
  policy: ReminderPolicy;
  source: ReminderSource;
}

export interface ReminderStatus {
  mode: "off" | "after-turn" | "after-minutes";
  minutes?: number;
  source: ReminderSource;
}

export interface AttentionEvaluationInput {
  messages: readonly MailMessage[];
  effectiveReminder: EffectiveReminderPolicy;
  durablyNudgedIds: ReadonlySet<string>;
  acceptedSendIds: ReadonlySet<string>;
  idle: boolean;
  nowMs: number;
}

export const PI_MAIL_NUDGE_CUSTOM_TYPE = "pi-mail-nudge";
export const MIN_REMINDER_MINUTES = 1;
export const MAX_REMINDER_MINUTES = 24 * 60;

export interface QuietNudgePlan {
  messageIds: string[];
  pendingCount: number;
  reason: "after-turn" | "age";
}

export interface AttentionPlan {
  pendingTo: number;
  pendingCc: number;
  humanMail: MailMessage[];
  urgentPeerMail: MailMessage[];
  quietNudge?: QuietNudgePlan;
  recheckWhenSettled: boolean;
}

export function parseReminderPolicy(value: unknown): ReminderPolicy {
  if (value === "off") return { kind: "off" };
  if (value === "after-turn") return { kind: "after-turn" };
  if (typeof value === "number" && Number.isInteger(value)
    && value >= MIN_REMINDER_MINUTES && value <= MAX_REMINDER_MINUTES) {
    return { kind: "after-minutes", minutes: value };
  }
  throw new Error(`Reminder must be off, after-turn, or an integer from ${MIN_REMINDER_MINUTES} through ${MAX_REMINDER_MINUTES}`);
}

export function reminderStatus(effective: EffectiveReminderPolicy): ReminderStatus {
  return effective.policy.kind === "after-minutes"
    ? { mode: "after-minutes", minutes: effective.policy.minutes, source: effective.source }
    : { mode: effective.policy.kind, source: effective.source };
}

function deliveryTime(mail: MailMessage): number {
  const timestamp = Date.parse(mail.delivery?.deliveredAt ?? mail.createdAt);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

function oldestFirst(messages: MailMessage[]): MailMessage[] {
  return messages.sort((a, b) => deliveryTime(a) - deliveryTime(b) || a.id.localeCompare(b.id));
}

export function evaluateAttention(input: AttentionEvaluationInput): AttentionPlan {
  const unpresented = input.messages.filter((mail) => !mail.delivery?.presentedAt);
  const humanMail = oldestFirst(unpresented.filter((mail) => mail.senderKind === "human"));
  const urgentPeerMail = oldestFirst(unpresented.filter(shouldInterruptForPeerMail));
  const quietDirect = oldestFirst(unpresented.filter((mail) =>
    mail.senderKind === "session"
    && mail.delivery?.kind === "to"
    && !mail.notify
  ));
  const eligible = quietDirect.filter((mail) =>
    !input.durablyNudgedIds.has(mail.id) && !input.acceptedSendIds.has(mail.id)
  );

  const plan: AttentionPlan = {
    pendingTo: unpresented.filter((mail) => mail.delivery?.kind === "to").length,
    pendingCc: unpresented.filter((mail) => mail.delivery?.kind === "cc").length,
    humanMail,
    urgentPeerMail,
    recheckWhenSettled: false,
  };
  if (eligible.length === 0 || input.effectiveReminder.policy.kind === "off") return plan;

  let reason: QuietNudgePlan["reason"] | undefined;
  if (input.effectiveReminder.policy.kind === "after-turn") {
    reason = "after-turn";
  } else {
    const oldestDeliveredAt = deliveryTime(eligible[0]);
    if (Number.isFinite(oldestDeliveredAt)
      && input.nowMs - oldestDeliveredAt >= input.effectiveReminder.policy.minutes * 60_000) {
      reason = "age";
    }
  }
  if (!reason) return plan;
  if (!input.idle) {
    plan.recheckWhenSettled = true;
    return plan;
  }

  plan.quietNudge = {
    messageIds: eligible.map((mail) => mail.id),
    pendingCount: quietDirect.length,
    reason,
  };
  return plan;
}

export function shouldInterruptForPeerMail(mail: MailMessage): boolean {
  return mail.senderKind === "session" && mail.notify && mail.delivery?.kind === "to";
}
