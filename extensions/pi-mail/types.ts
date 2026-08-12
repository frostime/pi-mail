export type RecipientKind = "to" | "cc";
export type SenderKind = "session" | "human";

export interface PeerRecord {
  version: 1;
  id: string;
  alias: string;
  cwd: string;
  discoverable: boolean;
  createdAt: string;
  updatedAt: string;
  /** Tombstone set by the human mailbox administrator; init clears it on resume. */
  deletedAt?: string;
}

export interface PresenceRecord {
  version: 1;
  sessionId: string;
  runtimeId: string;
  pid: number;
  cwd: string;
  startedAt: string;
  lastSeenAt: string;
}

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

export interface PeerAddress {
  id: string;
  shortId: string;
  alias: string;
}

export interface MailMessage {
  id: string;
  shortId: string;
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


export interface MailStatus {
  id: string;
  shortId: string;
  alias: string;
  discoverable: boolean;
  mailRoot: string;
  unpresented: { to: number; cc: number };
  activePeerCount: number;
}

export interface DiscoveredPeer extends PeerAddress {
  active: boolean;
  runtimeCount: number;
  cwd: string;
  lastSeenAt: string | null;
  /** True only when an internal caller explicitly includes the current session. */
  self?: boolean;
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
  shortId: string;
  subject: string;
  threadId: string;
  createdAt: string;
  recipients: SentRecipient[];
}

export interface ProjectMessageSummary extends MailMessage {
  recipients: SentRecipient[];
}
