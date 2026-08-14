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

/** Decode one settings/command/storage scalar into the internal policy type. */
export function parseReminderPolicy(_value: unknown): ReminderPolicy {
  throw new Error("mail-attention-policy reminder parsing is not implemented");
}

/**
 * mail-attention-policy::shape — the complete pure decision boundary. Runtime
 * lifecycle and Pi dispatch must not leak into this function.
 */
export function evaluateAttention(_input: AttentionEvaluationInput): AttentionPlan {
  throw new Error("mail-attention-policy evaluation is not implemented");
}

export const MAILBOX_NOTICE_THRESHOLD = 3;
export const MIN_REMINDER_MINUTES = 1;
export const MAX_REMINDER_MINUTES = 24 * 60;

export function shouldInterruptForPeerMail(mail: MailMessage): boolean {
  return mail.senderKind === "session" && mail.notify && mail.delivery?.kind === "to";
}

export function mailboxNoticeBucket(pendingCount: number): number {
  return Math.floor(Math.max(0, pendingCount) / MAILBOX_NOTICE_THRESHOLD);
}

export function normalizeReminderMinutes(value: number | null | undefined): number | null {
  if (value == null || value === 0) return null;
  const minutes = Math.trunc(Number(value));
  if (!Number.isFinite(minutes) || minutes < MIN_REMINDER_MINUTES || minutes > MAX_REMINDER_MINUTES) {
    throw new Error(`Reminder minutes must be 0 (off) or ${MIN_REMINDER_MINUTES}-${MAX_REMINDER_MINUTES}`);
  }
  return minutes;
}

export function isOverdueDirectMail(
  mail: MailMessage,
  reminderAfterMinutes: number | null,
  nowMs = Date.now(),
): boolean {
  if (reminderAfterMinutes == null) return false;
  if (mail.senderKind !== "session" || mail.notify || mail.delivery?.kind !== "to") return false;
  if (mail.delivery?.presentedAt) return false;

  const deliveredAt = Date.parse(mail.delivery?.deliveredAt ?? mail.createdAt);
  if (!Number.isFinite(deliveredAt)) return false;
  return nowMs - deliveredAt >= reminderAfterMinutes * 60_000;
}
