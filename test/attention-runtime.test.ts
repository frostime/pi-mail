import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createAttentionRuntime, type AttentionMailbox } from "../extensions/pi-mail/attention-runtime.ts";
import type { EffectiveReminderPolicy } from "../extensions/pi-mail/attention-policy.ts";
import type { MailMessage, SenderKind } from "../extensions/pi-mail/types.ts";

function mail(id: string, options: { senderKind?: SenderKind; notify?: boolean } = {}): MailMessage {
  return {
    id,
    senderKind: options.senderKind ?? "session",
    from: { id: "sender", shortId: "sender", alias: "sender" },
    to: [],
    cc: [],
    subject: id,
    body: `body ${id}`,
    notify: options.notify ?? false,
    threadId: id,
    inReplyTo: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    delivery: { kind: "to", deliveredAt: "2026-01-01T00:00:00.000Z", presentedAt: null },
  };
}

function harness(options: {
  messages?: MailMessage[];
  effective?: EffectiveReminderPolicy;
  idle?: boolean;
  entries?: unknown[];
  listUnpresented?: () => Promise<MailMessage[]>;
} = {}) {
  let idle = options.idle ?? true;
  let effective = options.effective ?? { policy: { kind: "after-turn" }, source: "mailbox" as const };
  const messages = options.messages ?? [];
  const entries = options.entries ?? [];
  const calls: Array<{ type: string; value?: unknown }> = [];
  const presented: string[] = [];

  const pi = {
    sendUserMessage(content: unknown) {
      calls.push({ type: "user", value: content });
    },
    sendMessage(message: { customType: string; details?: unknown }) {
      calls.push({ type: message.customType, value: message.details });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    isIdle: () => idle,
    sessionManager: { getEntries: () => entries },
    ui: { setStatus: (_key: string, value: unknown) => calls.push({ type: "status", value }) },
  } as unknown as ExtensionContext;
  const mailbox: AttentionMailbox = {
    listUnpresentedForAttention: options.listUnpresented ?? (async () => messages),
    getEffectiveReminder: async () => effective,
    markPresented: async (messageId) => {
      presented.push(messageId);
      const message = messages.find((item) => item.id === messageId);
      if (message?.delivery) message.delivery.presentedAt = "2026-01-01T00:01:00.000Z";
    },
  };
  const runtime = createAttentionRuntime({ pi, ctx, mailbox, pollIntervalMs: 60_000 });

  return {
    runtime,
    calls,
    entries,
    messages,
    presented,
    setIdle(value: boolean) { idle = value; },
    setEffective(value: EffectiveReminderPolicy) { effective = value; },
  };
}

test("busy after-turn mail waits for agent_settled without pre-queuing a Pi message", async () => {
  const h = harness({ messages: [mail("quiet")], idle: false });
  h.runtime.start();
  await h.runtime.checkNow();
  assert.equal(h.calls.some((call) => call.type === "pi-mail-nudge"), false);

  h.setIdle(true);
  await h.runtime.onAgentSettled();
  assert.equal(h.calls.filter((call) => call.type === "pi-mail-nudge").length, 1);
  await h.runtime.stop();
});

test("changing a deferred reminder to off cancels the settled nudge", async () => {
  const h = harness({ messages: [mail("quiet")], idle: false });
  h.runtime.start();
  await h.runtime.checkNow();
  h.setEffective({ policy: { kind: "off" }, source: "mailbox" });
  h.setIdle(true);
  await h.runtime.onAgentSettled();
  assert.equal(h.calls.some((call) => call.type === "pi-mail-nudge"), false);
  await h.runtime.stop();
});

test("accepted and durable nudge receipts suppress repeats while new mail forms a later cohort", async () => {
  const h = harness({ messages: [mail("first")] });
  h.runtime.start();
  await h.runtime.checkNow();
  assert.equal(h.calls.filter((call) => call.type === "pi-mail-nudge").length, 1);

  await h.runtime.checkNow();
  assert.equal(h.calls.filter((call) => call.type === "pi-mail-nudge").length, 1);

  h.entries.push({
    type: "custom_message",
    customType: "pi-mail-nudge",
    details: { messageIds: ["first"], pendingCount: 1, reason: "after-turn" },
  });
  h.messages.push(mail("second"));
  await h.runtime.checkNow();
  const nudges = h.calls.filter((call) => call.type === "pi-mail-nudge");
  assert.equal(nudges.length, 2);
  assert.deepEqual(nudges[1].value, { messageIds: ["second"], pendingCount: 2, reason: "after-turn" });
  assert.deepEqual(h.presented, []);
  await h.runtime.stop();
});

test("history reconstruction suppresses an already durable cohort", async () => {
  const h = harness({
    messages: [mail("first")],
    entries: [{
      type: "custom_message",
      customType: "pi-mail-nudge",
      details: { messageIds: ["first"], pendingCount: 1, reason: "after-turn" },
    }],
  });
  h.runtime.start();
  await h.runtime.checkNow();
  assert.equal(h.calls.some((call) => call.type === "pi-mail-nudge"), false);
  await h.runtime.stop();
});

test("one scan dispatches human, urgent peer, then quiet nudge", async () => {
  const h = harness({ messages: [
    mail("quiet"),
    mail("urgent", { notify: true }),
    mail("human", { senderKind: "human" }),
  ] });
  h.runtime.start();
  await h.runtime.checkNow();
  assert.deepEqual(
    h.calls.filter((call) => ["user", "pi-mail", "pi-mail-nudge"].includes(call.type)).map((call) => call.type),
    ["user", "pi-mail", "pi-mail-nudge"],
  );
  assert.deepEqual(h.presented, ["human"]);
  await h.runtime.stop();
});

test("stopping an in-flight scan prevents stale runtime side effects", async () => {
  let resolveList!: (messages: MailMessage[]) => void;
  const list = new Promise<MailMessage[]>((resolve) => { resolveList = resolve; });
  const h = harness({ listUnpresented: () => list });
  h.runtime.start();
  const stopping = h.runtime.stop();
  resolveList([mail("late")]);
  await stopping;
  assert.equal(h.calls.some((call) => call.type === "pi-mail-nudge"), false);
  assert.deepEqual(h.presented, []);
});
