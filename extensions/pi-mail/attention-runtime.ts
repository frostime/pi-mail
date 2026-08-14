import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  evaluateAttention,
  PI_MAIL_NUDGE_CUSTOM_TYPE,
  reminderStatus,
  type EffectiveReminderPolicy,
  type ReminderStatus,
} from "./attention-policy.ts";
import { formatPeerMailContent } from "./tool-presentation.ts";
import type { MailMessage } from "./types.ts";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const PEER_MAIL_CUSTOM_TYPE = "pi-mail";

export interface AttentionMailbox {
  listUnpresentedForAttention(): Promise<MailMessage[]>;
  getEffectiveReminder(): Promise<EffectiveReminderPolicy>;
  markPresented(messageId: string): Promise<unknown>;
}

export interface AttentionRuntimeOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  mailbox: AttentionMailbox;
  pollIntervalMs?: number;
  now?: () => number;
}

export interface AttentionRuntime {
  start(): void;
  stop(): Promise<void>;
  checkNow(): Promise<void>;
  onAgentSettled(): Promise<void>;
  getReminderStatus(): Promise<ReminderStatus>;
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

function entryDetails(entry: unknown): { customType?: unknown; details?: unknown } | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  if (record.type !== "custom_message") return null;
  return { customType: record.customType, details: record.details };
}

function nudgeMessage(pendingCount: number): string {
  return `Pi Mail: ${pendingCount} quiet direct message${pendingCount === 1 ? " is" : "s are"} waiting. Use the mail tool to inspect the inbox.`;
}

export function createAttentionRuntime(options: AttentionRuntimeOptions): AttentionRuntime {
  const { pi, ctx, mailbox } = options;
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const durablyNudgedIds = new Set<string>();
  const acceptedNudgeIds = new Set<string>();
  const durablyPresentedPeerIds = new Set<string>();
  const acceptedPeerIds = new Set<string>();

  let running = false;
  let generation = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let activeCheck: Promise<void> | null = null;
  let rerunRequested = false;
  let settledRecheck = false;

  function isCurrent(expectedGeneration: number): boolean {
    return running && generation === expectedGeneration;
  }

  function reconcileHistory(): void {
    for (const entry of ctx.sessionManager.getEntries()) {
      const custom = entryDetails(entry);
      if (!custom) continue;
      if (custom.customType === PI_MAIL_NUDGE_CUSTOM_TYPE) {
        const details = custom.details as { messageIds?: unknown } | undefined;
        if (!Array.isArray(details?.messageIds)) continue;
        for (const id of details.messageIds) {
          if (typeof id !== "string") continue;
          durablyNudgedIds.add(id);
          acceptedNudgeIds.delete(id);
        }
      } else if (custom.customType === PEER_MAIL_CUSTOM_TYPE) {
        const details = custom.details as { messageId?: unknown } | undefined;
        if (typeof details?.messageId !== "string") continue;
        durablyPresentedPeerIds.add(details.messageId);
        acceptedPeerIds.delete(details.messageId);
      }
    }
  }

  async function reconcilePeerPresentation(expectedGeneration: number): Promise<void> {
    for (const messageId of durablyPresentedPeerIds) {
      if (!isCurrent(expectedGeneration)) return;
      await mailbox.markPresented(messageId);
    }
  }

  function refreshFooter(pendingTo: number, pendingCc: number): void {
    const total = pendingTo + pendingCc;
    ctx.ui.setStatus("pi-mail", total > 0 ? `mail ${total}` : undefined);
  }

  async function dispatchHuman(mail: MailMessage, expectedGeneration: number): Promise<void> {
    if (!isCurrent(expectedGeneration)) return;
    const content = humanMailContent(mail);
    if (ctx.isIdle()) pi.sendUserMessage(content);
    else pi.sendUserMessage(content, { deliverAs: "steer" });
    if (!isCurrent(expectedGeneration)) return;
    await mailbox.markPresented(mail.id);
  }

  function dispatchUrgentPeer(mail: MailMessage, expectedGeneration: number): void {
    if (!isCurrent(expectedGeneration)
      || durablyPresentedPeerIds.has(mail.id)
      || acceptedPeerIds.has(mail.id)) return;
    acceptedPeerIds.add(mail.id);
    pi.sendMessage({
      customType: PEER_MAIL_CUSTOM_TYPE,
      content: formatPeerMailContent(mail),
      display: true,
      details: {
        messageId: mail.id,
        threadId: mail.threadId,
        from: mail.from,
        recipientKind: mail.delivery?.kind,
      },
    }, { deliverAs: "steer", triggerTurn: true });
  }

  function dispatchNudge(
    quietNudge: NonNullable<ReturnType<typeof evaluateAttention>["quietNudge"]>,
    expectedGeneration: number,
  ): void {
    if (!isCurrent(expectedGeneration) || !ctx.isIdle()) {
      settledRecheck = true;
      return;
    }
    for (const messageId of quietNudge.messageIds) acceptedNudgeIds.add(messageId);
    pi.sendMessage({
      customType: PI_MAIL_NUDGE_CUSTOM_TYPE,
      content: nudgeMessage(quietNudge.pendingCount),
      display: true,
      details: quietNudge,
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  async function performCheck(expectedGeneration: number): Promise<void> {
    reconcileHistory();
    await reconcilePeerPresentation(expectedGeneration);
    if (!isCurrent(expectedGeneration)) return;

    const [messages, effectiveReminder] = await Promise.all([
      mailbox.listUnpresentedForAttention(),
      mailbox.getEffectiveReminder(),
    ]);
    if (!isCurrent(expectedGeneration)) return;

    reconcileHistory();
    const plan = evaluateAttention({
      messages,
      effectiveReminder,
      durablyNudgedIds,
      acceptedSendIds: acceptedNudgeIds,
      idle: ctx.isIdle(),
      nowMs: now(),
    });
    refreshFooter(plan.pendingTo, plan.pendingCc);
    settledRecheck = plan.recheckWhenSettled;

    for (const mail of plan.humanMail) {
      await dispatchHuman(mail, expectedGeneration);
      if (!isCurrent(expectedGeneration)) return;
    }
    for (const mail of plan.urgentPeerMail) {
      dispatchUrgentPeer(mail, expectedGeneration);
      if (!isCurrent(expectedGeneration)) return;
    }
    if (plan.quietNudge) dispatchNudge(plan.quietNudge, expectedGeneration);
  }

  async function checkLoop(): Promise<void> {
    do {
      rerunRequested = false;
      const expectedGeneration = generation;
      try {
        await performCheck(expectedGeneration);
      } catch (error) {
        if (isCurrent(expectedGeneration)) console.error("[pi-mail] attention check failed:", error);
      }
    } while (rerunRequested && running);
  }

  async function checkNow(): Promise<void> {
    if (!running) return;
    if (activeCheck) {
      rerunRequested = true;
      await activeCheck;
      return;
    }
    activeCheck = checkLoop().finally(() => {
      activeCheck = null;
    });
    await activeCheck;
  }

  return {
    start() {
      if (running) return;
      running = true;
      generation += 1;
      void checkNow();
      pollTimer = setInterval(() => void checkNow(), pollIntervalMs);
      pollTimer.unref();
    },

    async stop() {
      if (!running) return;
      running = false;
      generation += 1;
      settledRecheck = false;
      rerunRequested = false;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      await activeCheck;
      ctx.ui.setStatus("pi-mail", undefined);
      acceptedNudgeIds.clear();
      acceptedPeerIds.clear();
    },

    checkNow,

    async onAgentSettled() {
      if (!running || !settledRecheck) return;
      settledRecheck = false;
      await checkNow();
    },

    async getReminderStatus() {
      return reminderStatus(await mailbox.getEffectiveReminder());
    },
  };
}
