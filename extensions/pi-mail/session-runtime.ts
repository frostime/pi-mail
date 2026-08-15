import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ReminderStatus } from "./attention-policy.ts";
import { createAttentionRuntime } from "./attention-runtime.ts";
import { MailService } from "./mail-service.ts";
import { createPresenceRuntime } from "./presence-runtime.ts";
import { loadReminderSettings } from "./reminder-settings.ts";
import { startWebUi } from "./web-ui.ts";

export interface MailSessionRuntime {
  readonly mailbox: MailService;
  onAgentSettled(): Promise<void>;
  checkAttention(): Promise<void>;
  getReminderStatus(): Promise<ReminderStatus>;
  syncSessionName(name: string | undefined): Promise<void>;
  openWebUi(): Promise<string>;
  closeWebUi(): Promise<boolean>;
  dispose(): Promise<void>;
}

export async function createMailSessionRuntime(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
}): Promise<MailSessionRuntime> {
  const { pi, ctx } = options;
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

  try {
    await mailbox.init({ sessionName: pi.getSessionName() ?? null });
  } catch (error) {
    await mailbox.close().catch(() => {});
    throw error;
  }

  const attention = createAttentionRuntime({ pi, ctx, mailbox });
  const presence = createPresenceRuntime({ mailbox });
  let webUi: Awaited<ReturnType<typeof startWebUi>> | null = null;
  let disposed = false;
  let disposeTask: Promise<void> | null = null;

  attention.start();
  presence.start();

  function assertActive(): void {
    if (disposed) throw new Error("Pi Mail session runtime is disposed");
  }

  return {
    mailbox,

    onAgentSettled() {
      if (disposed) return Promise.resolve();
      return attention.onAgentSettled();
    },

    checkAttention() {
      if (disposed) return Promise.resolve();
      return attention.checkNow();
    },

    getReminderStatus() {
      if (disposed) return Promise.reject(new Error("Pi Mail session runtime is disposed"));
      return attention.getReminderStatus();
    },

    async syncSessionName(name) {
      if (disposed) return;
      await mailbox.syncSessionName(name);
    },

    async openWebUi() {
      assertActive();
      if (!webUi || webUi.closed) {
        const started = await startWebUi(mailbox);
        if (disposed) {
          await started.close().catch(() => {});
          assertActive();
        }
        webUi = started;
      }
      return webUi.url;
    },

    async closeWebUi() {
      if (!webUi || webUi.closed) {
        webUi = null;
        return false;
      }
      const handle = webUi;
      webUi = null;
      await handle.close();
      return true;
    },

    dispose() {
      if (disposeTask) return disposeTask;
      disposed = true;

      const handle = webUi;
      webUi = null;
      const stoppingAttention = attention.stop().catch((error) => {
        console.error("[pi-mail] attention shutdown failed:", error);
      });
      const stoppingPresence = presence.dispose().catch((error) => {
        console.error("[pi-mail] presence shutdown failed:", error);
      });

      disposeTask = Promise.all([stoppingAttention, stoppingPresence]).then(async () => {
        await handle?.close().catch((error) => {
          console.error("[pi-mail] Web UI shutdown failed:", error);
        });
        await mailbox.close().catch((error) => {
          console.error("[pi-mail] mailbox shutdown failed:", error);
        });
      });
      return disposeTask;
    },
  };
}
