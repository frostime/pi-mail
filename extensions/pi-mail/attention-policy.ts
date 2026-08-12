import type { MailMessage } from "./types.ts";

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
