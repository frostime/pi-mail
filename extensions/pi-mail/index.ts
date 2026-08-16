import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { parseReminderPolicy, type ReminderStatus } from "./attention-policy.ts";
import type { MailService } from "./mail-service.ts";
import { PI_MAIL_SETTINGS_NAMESPACE, PI_MAIL_REMINDER_SETTING } from "./reminder-settings.ts";
import { createMailSessionRuntime, type MailSessionRuntime } from "./session-runtime.ts";
import {
  collapsedResultLabel,
  formatToolContent,
  formatUserReminder,
  formatUserStatus,
  toolCallLabel,
  type MailAction,
  type MailToolArgs,
  type SendToolDetails,
} from "./tool-presentation.ts";
import { openWebUiInBrowser } from "./web-ui.ts";

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

function reminderHelp(status: ReminderStatus): string {
  return [
    `Pi Mail reminder: ${formatUserReminder(status)}.`,
    "Usage: /mail-reminder off|after-turn|<1-1440>|default",
    `Default for unconfigured mailboxes: ${PI_MAIL_SETTINGS_NAMESPACE}.${PI_MAIL_REMINDER_SETTING} in Pi settings.`,
  ].join("\n");
}

export default function piMailExtension(pi: ExtensionAPI): void {
  let activeSession: MailSessionRuntime | null = null;
  let settingsHintShown = false;

  function isActive(session: MailSessionRuntime): boolean {
    return activeSession === session;
  }

  function samePolicy(
    left: Awaited<ReturnType<MailService["getReminderOverride"]>>,
    right: Awaited<ReturnType<MailService["getReminderOverride"]>>,
  ): boolean {
    return left?.kind === right?.kind
      && (left?.kind !== "after-minutes" || right?.kind !== "after-minutes" || left.minutes === right.minutes);
  }

  pi.on("session_start", async (_event, ctx) => {
    const previous = activeSession;
    activeSession = null;
    await previous?.dispose();

    activeSession = await createMailSessionRuntime({ pi, ctx });
    settingsHintShown = false;
  });

  pi.on("session_info_changed", async (event) => {
    await activeSession?.syncSessionName(event.name);
  });

  pi.on("agent_settled", async () => {
    await activeSession?.onAgentSettled();
  });

  pi.on("session_shutdown", async (event) => {
    const session = activeSession;
    activeSession = null;
    await session?.dispose({ discardUnusedMailbox: event.reason !== "reload" });
  });

  pi.registerCommand("mail-reminder", {
    description: "Configure quiet-mail reminders: /mail-reminder off|after-turn|<minutes>|default",
    handler: async (args, ctx) => {
      const session = activeSession;
      if (!session) {
        ctx.ui.notify("Pi Mail is not ready for the current session.", "error");
        return;
      }

      const mailbox = session.mailbox;
      const value = args.trim().toLowerCase();
      if (!value) {
        const status = await session.getReminderStatus();
        if (!isActive(session)) return;
        ctx.ui.notify(reminderHelp(status), "info");
        return;
      }

      let policy;
      try {
        policy = value === "default"
          ? undefined
          : parseReminderPolicy(/^\d+$/.test(value) ? Number(value) : value);
      } catch {
        ctx.ui.notify("Usage: /mail-reminder off|after-turn|<1-1440>|default", "error");
        return;
      }

      const previous = await mailbox.getReminderOverride();
      if (!isActive(session)) return;
      await mailbox.configureReminder(policy);
      if (!isActive(session)) return;
      const changed = !samePolicy(previous, policy);
      const status = await session.getReminderStatus();
      if (!isActive(session)) return;
      ctx.ui.notify(`Pi Mail reminder set to ${formatUserReminder(status)}.`, "info");
      if (changed && !settingsHintShown && mailbox.defaultReminder.source === "built-in") {
        settingsHintShown = true;
        ctx.ui.notify(`Set ${PI_MAIL_SETTINGS_NAMESPACE}.${PI_MAIL_REMINDER_SETTING} in Pi settings to define the default for unconfigured mailboxes.`, "info");
      }
      if (changed) await session.checkAttention();
    },
  });

  pi.registerCommand("mail-status", {
    description: "Show the current Pi Mail mailbox and inbox status",
    handler: async (_args, ctx) => {
      const session = activeSession;
      if (!session) {
        ctx.ui.notify("Pi Mail is not ready for the current session.", "error");
        return;
      }

      const mailbox = session.mailbox;
      const status = await mailbox.status();
      const oldestToAt = await mailbox.oldestPendingToAt();
      if (!isActive(session)) return;
      ctx.ui.notify(formatUserStatus(status, oldestToAt), "info");
    },
  });

  pi.registerCommand("mail-rename", {
    description: "Rename the current mailbox: /mail-rename <name>",
    handler: async (args, ctx) => {
      const session = activeSession;
      if (!session) {
        ctx.ui.notify("Pi Mail is not ready for the current session.", "error");
        return;
      }

      const mailbox = session.mailbox;
      const value = args.trim();
      if (!value) {
        const status = await mailbox.status();
        if (!isActive(session)) return;
        ctx.ui.notify(
          `Pi Mail mailbox is currently "${status.alias}". Usage: /mail-rename <name> (1-64 characters, no slashes).`,
          "info",
        );
        return;
      }

      const peer = await mailbox.configure({ alias: value }).catch((error) => {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return null;
      });
      if (!peer || !isActive(session)) return;

      const peers = await mailbox.discover({ includeInactive: true });
      if (!isActive(session)) return;
      const clashes = peers.filter((other) => other.alias.toLowerCase() === peer.alias.toLowerCase());
      const note = clashes.length
        ? ` Alias is also used by ${clashes.map((other) => `${other.alias} (${other.shortId})`).join(", ")}; addressing may require the session ID.`
        : "";
      ctx.ui.notify(`Pi Mail mailbox renamed to "${peer.alias}".${note}`, "info");
    },
  });

  pi.registerCommand("mail-ui", {
    description: "Open Pi Mail Web UI; use /mail-ui close to stop it",
    handler: async (args, ctx) => {
      const session = activeSession;
      if (!session) {
        ctx.ui.notify("Pi Mail is not ready for the current session.", "error");
        return;
      }

      if (args.trim().toLowerCase() === "close") {
        const closed = await session.closeWebUi();
        if (!isActive(session)) return;
        ctx.ui.notify(closed ? "Pi Mail Web UI stopped." : "Pi Mail Web UI is not running.", "info");
        return;
      }

      const url = await session.openWebUi();
      if (!isActive(session)) return;
      openWebUiInBrowser(url);
      ctx.ui.notify(`Pi Mail Web UI: ${url}`, "info");
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
      const mailbox = activeSession?.mailbox;
      if (!mailbox) throw new Error("Pi Mail is not ready for the current session");

      switch (params.action) {
        case "status":
          return toolResult("status", await mailbox.status());
        case "discover":
          return toolResult("discover", await mailbox.discover({ includeInactive: params.include_inactive ?? false }));
        case "send": {
          const message = await mailbox.send({
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
            recipients: await mailbox.recipientStatusesFor(message.id),
          } satisfies SendToolDetails);
        }
        case "inbox":
          return toolResult("inbox", await mailbox.listInbox({
            messageId: params.message_id,
            unpresentedOnly: params.unpresented_only ?? false,
            limit: params.limit,
            markPresented: true,
          }));
        case "sent":
          return toolResult("sent", await mailbox.listSent({ limit: params.limit }));
        case "thread":
          return toolResult("thread", await mailbox.thread(params.message_id));
        case "wait":
          return toolResult("wait", await mailbox.waitForInbox({
            timeoutMs: (params.timeout_seconds ?? 60) * 1_000,
            signal,
          }));
        case "configure":
          return toolResult("configure", await mailbox.configure({
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
