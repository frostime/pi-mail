import type { MailMessage } from "./types.ts";

export const MAILBOX_NOTICE_THRESHOLD = 3;

export function shouldInterruptForPeerMail(mail: MailMessage): boolean {
  return mail.senderKind === "session" && mail.notify && mail.delivery?.kind === "to";
}

export function mailboxNoticeBucket(pendingCount: number): number {
  return Math.floor(Math.max(0, pendingCount) / MAILBOX_NOTICE_THRESHOLD);
}
