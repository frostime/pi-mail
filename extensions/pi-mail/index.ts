import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { parseReminderPolicy, type ReminderStatus } from "./attention-policy.ts";
import { createAttentionRuntime, type AttentionRuntime } from "./attention-runtime.ts";
import { MailService } from "./mail-service.ts";
import { loadReminderSettings, PI_MAIL_SETTINGS_NAMESPACE, PI_MAIL_REMINDER_SETTING } from "./reminder-settings.ts";
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

function reminderHelp(status: ReminderStatus): string {
  return [
    `Pi Mail reminder: ${formatUserReminder(status)}.`,
    "Usage: /mail-reminder off|after-turn|<1-1440>|default",
    `Default for unconfigured mailboxes: ${PI_MAIL_SETTINGS_NAMESPACE}.${PI_MAIL_REMINDER_SETTING} in Pi settings.`,
  ].join("\n");
}

export default function piMailExtension(pi: ExtensionAPI): void {
  let service: MailService | null = null;
  let attentionRuntime: AttentionRuntime | null = null;
  let currentCtx: ExtensionContext | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTask: Promise<void> | null = null;
  let lifecycleGeneration = 0;
  let webUi: Awaited<ReturnType<typeof startWebUi>> | null = null;
  let settingsHintShown = false;

  async function disposeSession(): Promise<void> {
    lifecycleGeneration += 1;
    const runtime = attentionRuntime;
    const mailbox = service;
    const heartbeat = heartbeatTask;
    attentionRuntime = null;
    service = null;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    await runtime?.stop().catch(() => {});
    await heartbeat?.catch(() => {});
    heartbeatTask = null;
    if (webUi) await webUi.close().catch(() => {});
    webUi = null;
    await mailbox?.close().catch(() => {});
    if (service === null) currentCtx = null;
  }

  function isCurrent(generation: number, mailbox: MailService): boolean {
    return lifecycleGeneration === generation && service === mailbox;
  }

  function samePolicy(
    left: Awaited<ReturnType<MailService["getReminderOverride"]>>,
    right: Awaited<ReturnType<MailService["getReminderOverride"]>>,
  ): boolean {
    return left?.kind === right?.kind
      && (left?.kind !== "after-minutes" || right?.kind !== "after-minutes" || left.minutes === right.minutes);
  }

  pi.on("session_start", async (_event, ctx) => {
    await disposeSession();
    currentCtx = ctx;
    settingsHintShown = false;
    const generation = lifecycleGeneration;

    const loadedSettings = loadReminderSettings(ctx.cwd, ctx.isProjectTrusted());
    for (const warning of loadedSettings.warnings) {
      console.warn(`[pi-mail] ${warning.message}`);
      if (ctx.hasUI) ctx.ui.notify(warning.message, "warning");
    }

    const mailbox = new MailService({
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      runtimeId: randomUUID(),
      defaultReminder: loadedSettings.defaultReminder,
    });
    await mailbox.init({ sessionName: pi.getSessionName() ?? null });
    if (lifecycleGeneration !== generation || currentCtx !== ctx) {
      await mailbox.close().catch(() => {});
      return;
    }

    service = mailbox;
    attentionRuntime = createAttentionRuntime({ pi, ctx, mailbox });
    attentionRuntime.start();

    heartbeatTimer = setInterval(() => {
      if (heartbeatTask || !isCurrent(generation, mailbox)) return;
      const task = mailbox.syncSessionName(pi.getSessionName() ?? null)
        .then(() => {
          if (!isCurrent(generation, mailbox)) return;
          return mailbox.heartbeat();
        })
        .catch((error) => console.error("[pi-mail] heartbeat failed:", error))
        .finally(() => {
          if (heartbeatTask === task) heartbeatTask = null;
        });
      heartbeatTask = task;
    }, 5_000);
    heartbeatTimer.unref();
  });

  pi.on("agent_settled", async () => {
    await attentionRuntime?.onAgentSettled();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (currentCtx !== ctx) return;
    await disposeSession();
  });

  pi.registerCommand("mail-reminder", {
    description: "Configure quiet-mail reminders: /mail-reminder off|after-turn|<minutes>|default",
    handler: async (args, ctx) => {
      const mailbox = service;
      const runtime = attentionRuntime;
      if (!mailbox || !runtime) {
        ctx.ui.notify("Pi Mail is not ready for the current session.", "error");
        return;
      }

      const generation = lifecycleGeneration;
      const value = args.trim().toLowerCase();
      if (!value) {
        const status = await runtime.getReminderStatus();
        if (!isCurrent(generation, mailbox)) return;
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
      if (!isCurrent(generation, mailbox)) return;
      await mailbox.configureReminder(policy);
      if (!isCurrent(generation, mailbox)) return;
      const changed = !samePolicy(previous, policy);
      const status = await runtime.getReminderStatus();
      if (!isCurrent(generation, mailbox)) return;
      ctx.ui.notify(`Pi Mail reminder set to ${formatUserReminder(status)}.`, "info");
      if (changed && !settingsHintShown && mailbox.defaultReminder.source === "built-in") {
        settingsHintShown = true;
        ctx.ui.notify(`Set ${PI_MAIL_SETTINGS_NAMESPACE}.${PI_MAIL_REMINDER_SETTING} in Pi settings to define the default for unconfigured mailboxes.`, "info");
      }
      if (changed) await runtime.checkNow();
    },
  });

  pi.registerCommand("mail-status", {
    description: "Show the current Pi Mail mailbox and inbox status",
    handler: async (_args, ctx) => {
      const mailbox = service;
      if (!mailbox) {
        ctx.ui.notify("Pi Mail is not ready for the current session.", "error");
        return;
      }

      const generation = lifecycleGeneration;
      const status = await mailbox.status();
      const oldestToAt = await mailbox.oldestPendingToAt();
      if (!isCurrent(generation, mailbox)) return;
      ctx.ui.notify(formatUserStatus(status, oldestToAt), "info");
    },
  });

  pi.registerCommand("mail-rename", {
    description: "Rename the current mailbox: /mail-rename <name>",
    handler: async (args, ctx) => {
      const mailbox = service;
      if (!mailbox) {
        ctx.ui.notify("Pi Mail is not ready for the current session.", "error");
        return;
      }

      const generation = lifecycleGeneration;
      const value = args.trim();
      if (!value) {
        const status = await mailbox.status();
        if (!isCurrent(generation, mailbox)) return;
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
      if (!peer || !isCurrent(generation, mailbox)) return;

      const peers = await mailbox.discover({ includeInactive: true });
      if (!isCurrent(generation, mailbox)) return;
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
      const mailbox = service;
      if (!mailbox) {
        ctx.ui.notify("Pi Mail is not ready for the current session.", "error");
        return;
      }

      const generation = lifecycleGeneration;
      if (args.trim().toLowerCase() === "close") {
        if (!webUi || webUi.closed) {
          webUi = null;
          ctx.ui.notify("Pi Mail Web UI is not running.", "info");
          return;
        }
        const handle = webUi;
        await handle.close();
        if (!isCurrent(generation, mailbox)) return;
        if (webUi === handle) webUi = null;
        ctx.ui.notify("Pi Mail Web UI stopped.", "info");
        return;
      }

      await mailbox.syncSessionName(pi.getSessionName() ?? null);
      if (!isCurrent(generation, mailbox)) return;
      if (!webUi || webUi.closed) {
        const started = await startWebUi(mailbox);
        if (!isCurrent(generation, mailbox)) {
          await started.close().catch(() => {});
          return;
        }
        webUi = started;
      }
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
      const mailbox = service;
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
