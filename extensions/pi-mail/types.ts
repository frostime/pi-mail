import type { ReminderStatus } from "./attention-policy.ts";

// Peer record shapes live with their migration/validation logic in peer-record.ts.
export type { LegacyPeerRecord } from "./peer-record.ts";

// ---------------------------------------------------------------------------
// Mail message model: canonical records, recipient deliveries, view shapes.
// ---------------------------------------------------------------------------

export type RecipientKind = "to" | "cc";
export type SenderKind = "session" | "human";

export interface MessageRecord {
  version: 1;
  id: string;
  /** Absent in Pi Mail 0.1 records; absence is interpreted as "session". */
  senderKind?: SenderKind;
  from: string;
  fromAlias: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  /** Optional in records written before Pi Mail 0.4; absence means false. */
  notify?: boolean;
  threadId: string;
  inReplyTo: string | null;
  createdAt: string;
}

export interface DeliveryRecord {
  version: 1;
  messageId: string;
  recipientId: string;
  kind: RecipientKind;
  deliveredAt: string;
  presentedAt: string | null;
}

export interface MailMessage {
  id: string;
  senderKind: SenderKind;
  from: PeerAddress;
  to: PeerAddress[];
  cc: PeerAddress[];
  subject: string;
  body: string;
  notify: boolean;
  threadId: string;
  inReplyTo: string | null;
  createdAt: string;
  delivery?: Pick<DeliveryRecord, "kind" | "deliveredAt" | "presentedAt">;
}

// ---------------------------------------------------------------------------
// Identity and discovery: who is present in the project and how their
// mailboxes appear to others.
// ---------------------------------------------------------------------------

export interface PresenceRecord {
  version: 1;
  sessionId: string;
  runtimeId: string;
  pid: number;
  cwd: string;
  startedAt: string;
  lastSeenAt: string;
}

export interface PeerAddress {
  id: string;
  shortId: string;
  alias: string;
}

export interface DiscoveredPeer extends PeerAddress {
  sessionName: string | null;
  active: boolean;
  runtimeCount: number;
  cwd: string;
  lastSeenAt: string | null;
  /** True only when an internal caller explicitly includes the current session. */
  self?: boolean;
}

export interface MailboxOverview extends DiscoveredPeer {
  pending: {
    to: number;
    cc: number;
    oldestToAt: string | null;
  };
  /** Latest mail activity involving this session: last delivered-to or sent-by time. */
  lastMailAt: string | null;
  reminder: ReminderStatus | null;
}

// ---------------------------------------------------------------------------
// Query results: status, sent/thread views, and wait outcomes.
// ---------------------------------------------------------------------------

export type WaitReason = "pending" | "new" | "timeout";

export interface MailStatus {
  id: string;
  shortId: string;
  alias: string;
  sessionName: string | null;
  discoverable: boolean;
  reminder: ReminderStatus;
  mailRoot: string;
  unpresented: { to: number; cc: number };
  activePeerCount: number;
}

export interface SentRecipient extends PeerAddress {
  kind: RecipientKind;
  deliveredAt: string | null;
  presentedAt: string | null;
  /** null is reserved for non-session principals such as the local human user. */
  active: boolean | null;
}

export interface SentMessageSummary {
  id: string;
  subject: string;
  threadId: string;
  createdAt: string;
  recipients: SentRecipient[];
}

export interface ProjectMessageSummary extends MailMessage {
  recipients: SentRecipient[];
}

export interface WaitResult {
  reason: WaitReason;
  waitedMs: number;
  messages: MailMessage[];
}