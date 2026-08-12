import type {
  DiscoveredPeer,
  MailMessage,
  MailStatus,
  PeerRecord,
  SentMessageSummary,
  SentRecipient,
} from "./types.ts";

export const BODY_PREVIEW_CHARS = 240;

export type MailAction = "status" | "discover" | "send" | "inbox" | "sent" | "thread" | "configure";

export type MailToolArgs = {
  action: MailAction;
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  notify?: boolean;
  reply_to?: string;
  reply_all?: boolean;
  message_id?: string;
  include_inactive?: boolean;
  unpresented_only?: boolean;
  limit?: number;
  alias?: string;
  discoverable?: boolean;
};

export type SendToolDetails = {
  message: MailMessage;
  recipients: SentRecipient[];
};

function peerLabel(peer: { alias: string; shortId: string }): string {
  return `${peer.alias} (${peer.shortId})`;
}

export function previewBody(body: string, maxChars = BODY_PREVIEW_CHARS): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatRecipientState(recipient: SentRecipient): string {
  const state = recipient.presentedAt ? "presented" : recipient.deliveredAt ? "delivered" : "pending";
  const activity = recipient.active === false ? ", inactive" : "";
  return `${recipient.kind.toUpperCase()} ${peerLabel(recipient)}: ${state}${activity}`;
}

function formatMailFull(mail: MailMessage): string {
  const to = mail.to.map(peerLabel).join(", ") || "(none)";
  const cc = mail.cc.length ? `\nCc: ${mail.cc.map(peerLabel).join(", ")}` : "";
  const delivery = mail.delivery ? `\nRecipient kind: ${mail.delivery.kind.toUpperCase()}` : "";

  return [
    `[${mail.shortId}] ${mail.subject}`,
    `From: ${peerLabel(mail.from)}`,
    `To: ${to}${cc}${delivery}`,
    `Message-ID: ${mail.id}`,
    `Thread: ${mail.threadId}`,
    "",
    mail.body,
  ].join("\n");
}

function formatMailPreview(mail: MailMessage): string {
  const recipientKind = mail.delivery ? ` · ${mail.delivery.kind.toUpperCase()}` : "";
  return `[${mail.shortId}] ${mail.subject} · ${peerLabel(mail.from)}${recipientKind}\n${previewBody(mail.body)}`;
}

export function formatToolContent(action: MailAction, value: unknown): string {
  switch (action) {
    case "status": {
      const status = value as MailStatus;
      return [
        `Mailbox ${status.alias} (${status.shortId}); discoverable=${status.discoverable ? "yes" : "no"}.`,
        `Active peers: ${status.activePeerCount}. Pending: ${status.unpresented.to} To, ${status.unpresented.cc} Cc.`,
        `Store: ${status.mailRoot}`,
      ].join("\n");
    }

    case "discover": {
      const peers = value as DiscoveredPeer[];
      if (!peers.length) return "No discoverable sessions found.";
      return [
        `${peers.length} session${peers.length === 1 ? "" : "s"}:`,
        ...peers.map((peer) => `- ${peerLabel(peer)} · ${peer.active ? "active" : "inactive"}${peer.cwd ? ` · ${peer.cwd}` : ""}`),
      ].join("\n");
    }

    case "send": {
      const { message, recipients } = value as SendToolDetails;
      const to = message.to.map(peerLabel).join(", ");
      const cc = message.cc.length ? `; Cc ${message.cc.map(peerLabel).join(", ")}` : "";
      const inactive = recipients.filter((recipient) => recipient.active === false);
      const lines = [`Sent [${message.shortId}] "${message.subject}" to ${to}${cc}.`];
      if (message.notify) lines.push("Immediate notification requested for direct To recipients.");
      if (inactive.length) {
        lines.push(`Inactive recipient${inactive.length === 1 ? "" : "s"}: ${inactive.map(peerLabel).join(", ")}. Mail was delivered to their mailbox and will remain there until the session becomes active again.`);
      }
      return lines.join("\n");
    }

    case "inbox": {
      if (!Array.isArray(value)) return formatMailFull(value as MailMessage);
      const messages = value as MailMessage[];
      if (!messages.length) return "Inbox is empty.";
      return [
        `${messages.length} inbox message${messages.length === 1 ? "" : "s"}:`,
        ...messages.map(formatMailPreview),
        "Use inbox with message_id to read one message in full.",
      ].join("\n\n");
    }

    case "sent": {
      const messages = value as SentMessageSummary[];
      if (!messages.length) return "No sent messages.";
      return [
        `${messages.length} sent message${messages.length === 1 ? "" : "s"}:`,
        ...messages.map((message) => {
          const recipients = message.recipients.map(formatRecipientState).join("; ");
          return `- [${message.shortId}] ${message.subject} · ${recipients || "no recipients"}`;
        }),
      ].join("\n");
    }

    case "thread": {
      const messages = value as MailMessage[];
      if (!messages.length) return "Thread is empty.";
      return [
        `Thread ${messages[0].threadId.slice(0, 8)} · ${messages.length} message${messages.length === 1 ? "" : "s"}`,
        "",
        messages.map(formatMailPreview).join("\n\n"),
      ].join("\n");
    }

    case "configure": {
      const peer = value as PeerRecord;
      return `Mailbox identity updated: ${peer.alias} (${peer.id.slice(0, 8)}); discoverable=${peer.discoverable ? "yes" : "no"}.`;
    }
  }
}

export function toolCallLabel(args: MailToolArgs): string {
  switch (args.action) {
    case "send": {
      const recipients = args.to?.length ? ` → ${args.to.join(", ")}` : args.reply_to ? ` ↩ ${args.reply_to}` : "";
      const subject = args.subject ? ` · ${args.subject}` : "";
      const notify = args.notify ? " · notify" : "";
      return `send${recipients}${subject}${notify}`;
    }
    case "inbox":
      return args.message_id ? `inbox ${args.message_id}` : `inbox${args.unpresented_only ? " · pending" : ""}`;
    case "thread":
      return `thread ${args.message_id ?? ""}`.trim();
    case "discover":
      return `discover${args.include_inactive ? " · incl. history" : ""}`;
    case "configure": {
      const changes = [args.alias ? `alias=${args.alias}` : "", args.discoverable === undefined ? "" : `discoverable=${args.discoverable}`].filter(Boolean);
      return `configure${changes.length ? ` · ${changes.join(" · ")}` : ""}`;
    }
    default:
      return args.action;
  }
}

export function collapsedResultLabel(action: MailAction, value: unknown): string {
  switch (action) {
    case "status": {
      const status = value as MailStatus;
      return `${status.alias} (${status.shortId}) · ${status.activePeerCount} active peer${status.activePeerCount === 1 ? "" : "s"}`;
    }
    case "discover": {
      const peers = value as DiscoveredPeer[];
      return `${peers.length} session${peers.length === 1 ? "" : "s"}`;
    }
    case "send": {
      const { message, recipients } = value as SendToolDetails;
      const inactive = recipients.filter((recipient) => recipient.active === false).length;
      return `sent ${message.shortId} → ${message.to.map((peer) => peer.alias).join(", ")}${inactive ? ` · ${inactive} inactive` : ""}`;
    }
    case "inbox": {
      const messages = Array.isArray(value) ? value as MailMessage[] : [value as MailMessage];
      if (messages.length === 1) return `${messages[0].shortId} · ${messages[0].from.alias} · ${messages[0].subject}`;
      return `${messages.length} inbox message${messages.length === 1 ? "" : "s"}`;
    }
    case "sent": {
      const messages = value as SentMessageSummary[];
      return `${messages.length} sent message${messages.length === 1 ? "" : "s"}`;
    }
    case "thread": {
      const messages = value as MailMessage[];
      return `${messages.length} message${messages.length === 1 ? "" : "s"} in thread ${messages[0]?.threadId.slice(0, 8) ?? ""}`.trim();
    }
    case "configure": {
      const peer = value as PeerRecord;
      return `${peer.alias} (${peer.id.slice(0, 8)})`;
    }
  }
}
