import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { EffectiveReminderPolicy, ReminderStatus } from "./attention-policy.ts";
import type { MailMessage } from "./types.ts";

/** Intent-level mailbox operations required by the Pi attention adapter. */
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
}

/** One runtime belongs to exactly one started Pi session context. */
export interface AttentionRuntime {
  start(): void;
  stop(): Promise<void>;
  checkNow(): Promise<void>;
  onAgentSettled(): Promise<void>;
  getReminderStatus(): Promise<ReminderStatus>;
}

/**
 * mail-attention-policy::shape — this factory is the sole stateful owner of
 * polling, accepted-send IDs, Pi history receipts, and attention side effects.
 */
export function createAttentionRuntime(_options: AttentionRuntimeOptions): AttentionRuntime {
  throw new Error("mail-attention-policy AttentionRuntime is not implemented");
}
