import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { isOverdueDirectMail, MAILBOX_NOTICE_THRESHOLD, mailboxNoticeBucket, shouldInterruptForPeerMail } from "./attention-policy.ts";
import type { AttentionRuntime } from "./attention-runtime.ts";
import { HUMAN_PRINCIPAL_ID, MailService } from "./mail-service.ts";
import {
  collapsedResultLabel,
  formatPeerMailContent,
  formatToolContent,
  toolCallLabel,
  type MailAction,
  type MailToolArgs,
  type SendToolDetails,
} from "./tool-presentation.ts";
import type { MailMessage } from "./types.ts";
import { openWebUiInBrowser, startWebUi } from "./web-ui.ts";

const ACTION = Type.Union([
  Type.Literal("status"),
  Type.Literal("discover"),
  Type.Literal("send"),
  Type.Literal("inbox"),
  Type.Literal("sent"),
  Type.Literal("thread"),
  Type.Literal("wait"),
  Type.Literal("configure"),
]);

function toolResult(action: MailAction, value: unknown) {
  return {
    content: [{ type: "text" as const, text: formatToolContent(action, value) }],
    details: value,
  };
}

function humanMailContent(mail: MailMessage): string {
  return [
    `[Pi Mail · message ${mail.id}]`,
    `Sent: ${mail.createdAt}`,
    `Subject: ${mail.subject}`,
    "",
    mail.body,
  ].join("\n");
}

function persistedPeerMailIds(ctx: ExtensionContext): Set<string> {
  const ids = new Set<string>();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom_message" || entry.customType !== "pi-mail") continue;
    const details = entry.details as { messageId?: unknown } | undefined;
    if (typeof details?.messageId === "string") ids.add(details.messageId);
  }
  return ids;
}

export default function piMailExtension(pi: ExtensionAPI): void {
  const runtimeId = randomUUID();

  let service: MailService | null = null;
  let attentionRuntime: AttentionRuntime | null = null;
  let currentCtx: ExtensionContext | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let inboxTimer: ReturnType<typeof setInterval> | null = null;
  let webUi: Awaited<ReturnType<typeof startWebUi>> | null = null;
  let processingInbox = false;
  let lastMailboxNoticeBucket = 0;
  let staleReminderSent = false;
  const queuedMessageIds = new Set<string>();

  function clearTimers(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (inboxTimer) clearInterval(inboxTimer);
    heartbeatTimer = null;
    inboxTimer = null;
  }

  async function syncPresentedFromSession(): Promise<void> {
    if (!service || !currentCtx) return;

    for (const messageId of persistedPeerMailIds(currentCtx)) {
      await service.markPresented(messageId);
      queuedMessageIds.delete(messageId);
    }
  }

  async function deliverHumanMail(mail: MailMessage): Promise<void> {
    if (!service || !currentCtx) return;

    const content = humanMailContent(mail);
    if (currentCtx.isIdle()) pi.sendUserMessage(content);
    else pi.sendUserMessage(content, { deliverAs: "steer" });

    // sendUserMessage has no extension metadata that can later be matched back
    // to this delivery, so API acceptance is the strongest visible boundary.
    await service.markPresented(mail.id);
  }

  async function deliverNotifyingPeerMail(mail: MailMessage): Promise<void> {
    if (queuedMessageIds.has(mail.id)) return;

    pi.sendMessage(
      {
        customType: "pi-mail",
        content: formatPeerMailContent(mail),
        display: true,
        details: {
          messageId: mail.id,
          threadId: mail.threadId,
          from: mail.from,
          recipientKind: mail.delivery?.kind,
        },
      },
      { deliverAs: "steer", triggerTurn: true },
    );

    // Pi may exit before a queued custom message reaches session history.
    // presentedAt advances only after that durable history entry exists.
    queuedMessageIds.add(mail.id);
  }

  function maybeNotifyMailboxBacklog(pendingCount: number): void {
    const bucket = mailboxNoticeBucket(pendingCount);
    if (bucket === 0) {
      lastMailboxNoticeBucket = 0;
      return;
    }
    if (bucket <= lastMailboxNoticeBucket) return;

    lastMailboxNoticeBucket = bucket;
    pi.sendMessage(
      {
        customType: "pi-mail-notice",
        content: `Pi Mail: ${pendingCount} messages are waiting in your mailbox. Use the mail tool to review them when appropriate.`,
        display: true,
        details: { pendingCount },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }


  function refreshFooterStatus(pendingTo: number, pendingCc: number): void {
    if (!currentCtx) return;
    const total = pendingTo + pendingCc;
    currentCtx.ui.setStatus("pi-mail", total > 0 ? `mail ${total}` : undefined);
  }

  async function maybeNotifyStaleMailbox(pendingDirect: MailMessage[]): Promise<void> {
    if (!service) return;
    const reminderAfterMinutes = await service.reminderAfterMinutes();
    if (reminderAfterMinutes == null || pendingDirect.length === 0 || pendingDirect.length >= MAILBOX_NOTICE_THRESHOLD) {
      staleReminderSent = false;
      return;
    }

    const overdue = pendingDirect.filter((mail) => isOverdueDirectMail(mail, reminderAfterMinutes));
    if (overdue.length === 0) {
      staleReminderSent = false;
      return;
    }
    if (staleReminderSent) return;

    staleReminderSent = true;
    pi.sendMessage(
      {
        customType: "pi-mail-reminder",
        content: `Pi Mail: ${overdue.length} direct message${overdue.length === 1 ? " has" : "s have"} been waiting for at least ${reminderAfterMinutes} minute${reminderAfterMinutes === 1 ? "" : "s"}. Use the mail tool to review your inbox when appropriate.`,
        display: true,
        details: { pendingCount: overdue.length, reminderAfterMinutes },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  // mail-attention-policy::shape — this whole flow moves behind
  // createAttentionRuntime; index.ts must not retain attention decisions/state.
  async function processIncoming(): Promise<void> {
    if (!service || processingInbox) return;
    processingInbox = true;

    try {
      await syncPresentedFromSession();
      const pending = await service.listInbox({
        unpresentedOnly: true,
        limit: 100,
        oldestFirst: true,
        markPresented: false,
      }) as MailMessage[];

      for (const mail of pending) {
        if (mail.senderKind === "human" || mail.from.id === HUMAN_PRINCIPAL_ID) {
          await deliverHumanMail(mail);
          continue;
        }

        if (shouldInterruptForPeerMail(mail)) {
          await deliverNotifyingPeerMail(mail);
        }
      }

      const silentDirectPending = pending.filter((mail) =>
        mail.senderKind === "session"
        && mail.delivery?.kind === "to"
        && !shouldInterruptForPeerMail(mail)
        && !queuedMessageIds.has(mail.id)
      );
      const pendingCc = pending.filter((mail) => mail.delivery?.kind === "cc").length;
      maybeNotifyMailboxBacklog(silentDirectPending.length);
      await maybeNotifyStaleMailbox(silentDirectPending);
      refreshFooterStatus(
        pending.filter((mail) => mail.delivery?.kind === "to").length,
        pendingCc,
      );
    } catch (error) {
      console.error("[pi-mail] incoming delivery failed:", error);
    } finally {
      processingInbox = false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await attentionRuntime?.stop();
    attentionRuntime = null;
    clearTimers();
    queuedMessageIds.clear();
    lastMailboxNoticeBucket = 0;
    staleReminderSent = false;
    currentCtx = ctx;

    service = new MailService({
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      runtimeId,
    });
    await service.init({ sessionName: pi.getSessionName() ?? null });

    // mail-attention-policy::shape — construct and start AttentionRuntime here,
    // after mailbox initialization and before any inbox polling begins.
    heartbeatTimer = setInterval(() => {
      const current = service;
      if (!current) return;
      void current.syncSessionName(pi.getSessionName() ?? null)
        .then(() => current.heartbeat())
        .catch((error) => console.error("[pi-mail] heartbeat failed:", error));
    }, 5_000);
    heartbeatTimer.unref();

    inboxTimer = setInterval(() => void processIncoming(), 1_000);
    inboxTimer.unref();
    setTimeout(() => void processIncoming(), 0).unref();
  });

  pi.on("agent_settled", async () => {
    await attentionRuntime?.onAgentSettled();
  });

  pi.on("session_shutdown", async () => {
    await attentionRuntime?.stop();
    attentionRuntime = null;
    clearTimers();
    currentCtx?.ui.setStatus("pi-mail", undefined);
    if (webUi) await webUi.close().catch(() => {});
    webUi = null;
    if (service) await service.close().catch(() => {});
    service = null;
    currentCtx = null;
    queuedMessageIds.clear();
    lastMailboxNoticeBucket = 0;
    staleReminderSent = false;
  });

  pi.registerCommand("mail-reminder", {
    description: "Configure stale-mail reminders for this mailbox: /mail-reminder off|<minutes>",
    handler: async (args, ctx) => {
      if (!service) {
        ctx.ui.notify("Pi Mail is not ready for the current session.", "error");
        return;
      }

      const value = args.trim().toLowerCase();
      if (!value) {
        const minutes = await service.reminderAfterMinutes();
        ctx.ui.notify(
          minutes == null ? "Pi Mail stale-mail reminder is off." : `Pi Mail stale-mail reminder: ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          "info",
        );
        return;
      }

      const minutes = value === "off" || value === "0" ? null : Number(value);
      if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
        ctx.ui.notify("Usage: /mail-reminder off|<1-1440 minutes>", "error");
        return;
      }

      await service.configureReminder(minutes);
      staleReminderSent = false;
      ctx.ui.notify(
        minutes == null ? "Pi Mail stale-mail reminder disabled." : `Pi Mail stale-mail reminder set to ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        "info",
      );
      void processIncoming();
    },
  });

  pi.registerCommand("mail-ui", {
    description: "Open Pi Mail Web UI; use /mail-ui close to stop it",
    handler: async (args, ctx) => {
      if (!service) {
        ctx.ui.notify("Pi Mail is not ready for the current session.", "error");
        return;
      }

      if (args.trim().toLowerCase() === "close") {
        if (!webUi || webUi.closed) {
          webUi = null;
          ctx.ui.notify("Pi Mail Web UI is not running.", "info");
          return;
        }
        await webUi.close();
        webUi = null;
        ctx.ui.notify("Pi Mail Web UI stopped.", "info");
        return;
      }

      await service.syncSessionName(pi.getSessionName() ?? null);
      if (!webUi || webUi.closed) webUi = await startWebUi(service);
      openWebUiInBrowser(webUi.url);
      ctx.ui.notify(`Pi Mail Web UI: ${webUi.url}`, "info");
    },
  });

  pi.registerTool({
    name: "mail",
    label: "Pi Mail",
    description: "Mailbox between Pi sessions. Load the pi-mail skill for usage details.",
    parameters: Type.Object({
      action: ACTION,
      to: Type.Optional(Type.Array(Type.String())),
      cc: Type.Optional(Type.Array(Type.String())),
      subject: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      notify: Type.Optional(Type.Boolean({ description: "Interrupt direct To recipients; default false." })),
      reply_to: Type.Optional(Type.String()),
      reply_all: Type.Optional(Type.Boolean()),
      message_id: Type.Optional(Type.String()),
      include_inactive: Type.Optional(Type.Boolean()),
      unpresented_only: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "For wait; defaults to 60 seconds." })),
      alias: Type.Optional(Type.String()),
      discoverable: Type.Optional(Type.Boolean()),
    }),

    async execute(_toolCallId, params, signal) {
      if (!service) throw new Error("Pi Mail is not ready for the current session");

      switch (params.action) {
        case "status":
          return toolResult("status", await service.status());
        case "discover":
          return toolResult("discover", await service.discover({ includeInactive: params.include_inactive ?? false }));
        case "send": {
          const message = await service.send({
            to: params.to,
            cc: params.cc ?? [],
            subject: params.subject,
            body: params.body,
            notify: params.notify ?? false,
            replyTo: params.reply_to,
            replyAll: params.reply_all ?? false,
          });
          return toolResult("send", {
            message,
            recipients: await service.recipientStatusesFor(message.id),
          } satisfies SendToolDetails);
        }
        case "inbox":
          return toolResult("inbox", await service.listInbox({
            messageId: params.message_id,
            unpresentedOnly: params.unpresented_only ?? false,
            limit: params.limit,
            markPresented: true,
          }));
        case "sent":
          return toolResult("sent", await service.listSent({ limit: params.limit }));
        case "thread":
          return toolResult("thread", await service.thread(params.message_id));
        case "wait":
          return toolResult("wait", await service.waitForInbox({
            timeoutMs: (params.timeout_seconds ?? 60) * 1_000,
            signal,
          }));
        case "configure":
          return toolResult("configure", await service.configure({
            alias: params.alias,
            discoverable: params.discoverable,
          }));
      }
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(`${theme.fg("toolTitle", theme.bold("mail"))} ${theme.fg("muted", toolCallLabel(args as MailToolArgs))}`);
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("muted", "…"));
        return text;
      }

      const action = (context.args as MailToolArgs).action;
      if (context.isError) {
        const errorText = result.content.find((item) => item.type === "text")?.text ?? "Pi Mail failed";
        text.setText(theme.fg("error", errorText));
        return text;
      }

      const fullText = result.content.find((item) => item.type === "text")?.text ?? "";
      const displayText = expanded ? fullText : collapsedResultLabel(action, result.details);
      text.setText(`${theme.fg("success", "✓")} ${displayText}`);
      return text;
    },
  });
}
