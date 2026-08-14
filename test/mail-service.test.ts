import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HUMAN_PRINCIPAL_ID, MailService } from "../extensions/pi-mail/mail-service.ts";
import { shouldInterruptForPeerMail } from "../extensions/pi-mail/attention-policy.ts";
import { resolveProjectRoot } from "../extensions/pi-mail/project-root.ts";
import { BODY_PREVIEW_CHARS, formatPeerMailContent, formatToolContent } from "../extensions/pi-mail/tool-presentation.ts";
import { shortSessionId } from "../extensions/pi-mail/identity.ts";
import type { MailMessage } from "../extensions/pi-mail/types.ts";

async function makeServices() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-test-"));
  const a = new MailService({
    cwd,
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    runtimeId: "runtime-a",
    presenceTtlMs: 60_000,
  });
  const b = new MailService({
    cwd,
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    runtimeId: "runtime-b",
    presenceTtlMs: 60_000,
  });
  const c = new MailService({
    cwd,
    sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    runtimeId: "runtime-c",
    presenceTtlMs: 60_000,
  });

  await a.init({ alias: "alice" });
  await b.init({ alias: "bob" });
  await c.init({ alias: "carol" });
  return { cwd, a, b, c };
}

async function inbox(service: MailService): Promise<MailMessage[]> {
  return await service.listInbox({ markPresented: false }) as MailMessage[];
}

test("initialization creates a self-contained mails .gitignore", async () => {
  const { a } = await makeServices();
  const text = await readFile(path.join(a.root, ".gitignore"), "utf8");
  assert.equal(text, "# Pi Mail runtime data\n*\n!.gitignore\n");
});

test("discovery is active-only by default but preserves historical peers", async () => {
  const { a, b } = await makeServices();

  assert.deepEqual(
    (await a.discover()).map((peer) => peer.alias).sort(),
    ["bob", "carol"],
  );

  await b.close();
  assert.deepEqual((await a.discover()).map((peer) => peer.alias), ["carol"]);
  assert.deepEqual(
    (await a.discover({ includeInactive: true })).map((peer) => peer.alias).sort(),
    ["bob", "carol"],
  );
});


test("session short IDs use the random UUID tail and are valid recipient addresses", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-v7-"));
  const firstId = "019ff5f7-12e9-71bf-850b-76732fe0a69c";
  const secondId = "019ff5f7-323e-7f29-bbcd-bb4b63d4b781";
  const first = new MailService({ cwd, sessionId: firstId, runtimeId: "runtime-v7-a", presenceTtlMs: 60_000 });
  const second = new MailService({ cwd, sessionId: secondId, runtimeId: "runtime-v7-b", presenceTtlMs: 60_000 });
  await first.init({ alias: "first" });
  await second.init({ alias: "second" });

  assert.equal(shortSessionId(firstId), "76732fe0a69c");
  assert.equal(shortSessionId(secondId), "bb4b63d4b781");
  const peer = (await first.discover()).find((item) => item.id === secondId);
  assert.equal(peer?.shortId, "bb4b63d4b781");

  const sent = await first.send({ to: [peer!.shortId], body: "Addressed by displayed session short ID." });
  assert.equal((await inbox(second))[0].id, sent.id);
});

test("legacy timestamp-prefix default aliases migrate to generated aliases", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-alias-migration-"));
  const sessionId = "019ff5f7-12e9-71bf-850b-76732fe0a69c";
  const service = new MailService({ cwd, sessionId, runtimeId: "runtime-migrate", presenceTtlMs: 60_000 });
  await service.store.init();
  const timestamp = new Date().toISOString();
  await writeFile(path.join(service.root, "peers", `${sessionId}.json`), JSON.stringify({
    version: 1,
    id: sessionId,
    alias: "session-019ff5f7",
    cwd,
    discoverable: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));

  const peer = await service.init();
  assert.equal(peer.alias, "S716");
});

test("new sessions receive a compact generated alias and avoid collisions", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-generated-alias-"));
  const first = new MailService({ cwd, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaa000001", runtimeId: "runtime-generated-a" });
  const second = new MailService({ cwd, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbb000001", runtimeId: "runtime-generated-b" });

  assert.equal((await first.init()).alias, "S001");
  assert.equal((await second.init()).alias, "S002");
});

test("Pi session names are tracked separately from mailbox aliases", async () => {
  const { b } = await makeServices();
  await b.syncSessionName("Review API compatibility");

  let status = await b.status();
  assert.equal(status.alias, "bob");
  assert.equal(status.sessionName, "Review API compatibility");

  await b.syncSessionName("Review API v2");
  status = await b.status();
  assert.equal(status.alias, "bob");
  assert.equal(status.sessionName, "Review API v2");
});

test("human supervisor session listing includes self and peer-hidden sessions", async () => {
  const { a, b } = await makeServices();
  await b.configure({ discoverable: false });

  assert.deepEqual((await a.discover()).map((peer) => peer.alias), ["carol"]);

  const sessions = await a.listProjectSessions({ includeInactive: true });
  assert.equal(sessions.find((peer) => peer.id === a.sessionId)?.self, true);
  assert.ok(sessions.some((peer) => peer.id === b.sessionId));
});

test("one message can address multiple To and Cc recipients", async () => {
  const { a, b, c } = await makeServices();

  const sent = await a.send({
    to: ["bob"],
    cc: ["carol"],
    subject: "Schema update",
    body: "The response now includes next_cursor.",
  });

  const bInbox = await inbox(b);
  const cInbox = await inbox(c);
  assert.equal(bInbox[0].id, sent.id);
  assert.equal(bInbox[0].delivery?.kind, "to");
  assert.equal(cInbox[0].id, sent.id);
  assert.equal(cInbox[0].delivery?.kind, "cc");
});

test("peer mail is quiet by default and persists an explicit notify hint", async () => {
  const { a } = await makeServices();

  const quiet = await a.send({ to: ["bob"], body: "quiet" });
  const notifying = await a.send({ to: ["bob"], body: "notify", notify: true });

  assert.equal(quiet.notify, false);
  assert.equal(notifying.notify, true);
  assert.equal((await a.store.getMessage(quiet.id))?.notify, false);
  assert.equal((await a.store.getMessage(notifying.id))?.notify, true);

  const quietDelivery = { ...quiet, delivery: { kind: "to" as const, deliveredAt: new Date().toISOString(), presentedAt: null } };
  const notifyingDelivery = { ...notifying, delivery: { kind: "to" as const, deliveredAt: new Date().toISOString(), presentedAt: null } };
  const notifyingCc = { ...notifying, delivery: { kind: "cc" as const, deliveredAt: new Date().toISOString(), presentedAt: null } };
  assert.equal(shouldInterruptForPeerMail(quietDelivery), false);
  assert.equal(shouldInterruptForPeerMail(notifyingDelivery), true);
  assert.equal(shouldInterruptForPeerMail(notifyingCc), false);
});

test("sending to an inactive historical mailbox succeeds and reports it inactive", async () => {
  const { a, b } = await makeServices();
  await b.close();

  const message = await a.send({ to: ["bob"], subject: "Offline", body: "Read this after resume." });
  const recipients = await a.recipientStatusesFor(message.id);

  assert.equal(recipients[0].active, false);
  assert.equal((await inbox(b))[0].id, message.id);
});

test("new message IDs are complete seven-character references", async () => {
  const { a, b } = await makeServices();

  const first = await a.send({
    to: ["bob"],
    subject: "Exact lookup",
    body: "Use the complete displayed message ID to reply.",
  });

  assert.match(first.id, /^[0-9a-z]{7}$/);

  const read = await b.listInbox({ messageId: first.id, markPresented: false }) as MailMessage;
  assert.equal(read.id, first.id);
  await assert.rejects(
    () => b.listInbox({ messageId: first.id.slice(0, 6), markPresented: false }),
    /Unknown message/,
  );

  const reply = await b.send({ replyTo: first.id, body: "Complete ID resolved." });
  assert.equal(reply.inReplyTo, first.id);
  assert.equal((await a.thread(reply.id)).length, 2);
});

test("UUID-era messages retain full IDs while accepting legacy short references", async () => {
  const { a, b } = await makeServices();
  const id = "1234abcd-1111-4111-8111-123456789abc";
  const createdAt = new Date().toISOString();

  await a.store.tryCreateMessage({
    version: 1,
    id,
    from: a.sessionId,
    fromAlias: "alice",
    to: [b.sessionId],
    cc: [],
    subject: "Legacy UUID",
    body: "Still addressable after the ID migration.",
    threadId: id,
    inReplyTo: null,
    createdAt,
  });
  await a.store.putDelivery({
    version: 1,
    messageId: id,
    recipientId: b.sessionId,
    kind: "to",
    deliveredAt: createdAt,
    presentedAt: null,
  });

  const listed = (await inbox(b)).find((message) => message.id === id);
  assert.equal(listed?.id, id);
  const read = await b.listInbox({ messageId: "1234abcd", markPresented: false }) as MailMessage;
  assert.equal(read.id, id);
});

test("ambiguous legacy message references list complete UUID candidates", async () => {
  const { a, b } = await makeServices();
  const firstId = "1234abcd-1111-4111-8111-123456789abc";
  const secondId = "1234abcd-2222-4222-8222-987654321def";
  const createdAt = new Date().toISOString();

  for (const [id, subject] of [[firstId, "First"], [secondId, "Second"]] as const) {
    await a.store.tryCreateMessage({
      version: 1,
      id,
      from: a.sessionId,
      fromAlias: "alice",
      to: [b.sessionId],
      cc: [],
      subject,
      body: "Legacy message",
      threadId: id,
      inReplyTo: null,
      createdAt,
    });
    await a.store.putDelivery({
      version: 1,
      messageId: id,
      recipientId: b.sessionId,
      kind: "to",
      deliveredAt: createdAt,
      presentedAt: null,
    });
  }

  await assert.rejects(
    () => b.listInbox({ messageId: "1234ab", markPresented: false }),
    (error: Error) => error.message.includes(firstId) && error.message.includes(secondId),
  );
});

test("message creation retries an atomic ID collision", async () => {
  const { a } = await makeServices();
  const tryCreateMessage = a.store.tryCreateMessage.bind(a.store);
  let attempts = 0;
  a.store.tryCreateMessage = async (message) => {
    attempts += 1;
    if (attempts === 1) return false;
    return tryCreateMessage(message);
  };

  const sent = await a.send({ to: ["bob"], body: "Retry once." });

  assert.equal(attempts, 2);
  assert.match(sent.id, /^[0-9a-z]{7}$/);
  assert.equal((await a.store.getMessage(sent.id))?.body, "Retry once.");
});

test("message creation stops after repeated ID collisions", async () => {
  const { a } = await makeServices();
  let attempts = 0;
  a.store.tryCreateMessage = async () => {
    attempts += 1;
    return false;
  };

  await assert.rejects(
    () => a.send({ to: ["bob"], body: "Never persisted." }),
    /Unable to allocate a unique message ID after 10 attempts/,
  );
  assert.equal(attempts, 10);
});

test("reply-all preserves the thread and original participants", async () => {
  const { a, b, c } = await makeServices();

  const first = await a.send({
    to: ["bob"],
    cc: ["carol"],
    subject: "Review request",
    body: "Please review the API.",
  });
  const reply = await b.send({
    replyTo: first.id,
    replyAll: true,
    body: "Reviewed. One concern remains.",
  });

  assert.equal(reply.threadId, first.threadId);
  assert.equal(reply.inReplyTo, first.id);
  assert.deepEqual(reply.to.map((peer) => peer.alias), ["alice"]);
  assert.deepEqual(reply.cc.map((peer) => peer.alias), ["carol"]);
  assert.equal((await c.thread(first.id)).length, 2);
});

test("sent status distinguishes delivery from presentation", async () => {
  const { a, b } = await makeServices();

  const message = await a.send({
    to: ["bob"],
    subject: "Ping",
    body: "Please check this.",
  });

  let sent = await a.listSent();
  assert.ok(sent[0].recipients[0].deliveredAt);
  assert.equal(sent[0].recipients[0].presentedAt, null);

  await b.listInbox({ messageId: message.id, markPresented: true });
  sent = await a.listSent();
  assert.ok(sent[0].recipients[0].presentedAt);
});

test("human-origin mail can be answered through the reserved user address", async () => {
  const { a, b } = await makeServices();

  const humanMessage = await a.sendAsHuman({
    to: ["bob"],
    subject: "Decision",
    body: "Please explain the compatibility tradeoff.",
  });
  assert.equal(humanMessage.from.id, HUMAN_PRINCIPAL_ID);
  assert.equal((await inbox(b))[0].senderKind, "human");

  const reply = await b.send({
    replyTo: humanMessage.id,
    body: "The old format is readable, but new writes include senderKind.",
  });
  assert.equal(reply.to[0].id, HUMAN_PRINCIPAL_ID);
  assert.equal(reply.threadId, humanMessage.threadId);
});

test("human supervisor can delete only inactive mailboxes without erasing shared messages", async () => {
  const { cwd, a, b } = await makeServices();
  const message = await a.send({ to: ["bob"], subject: "Keep shared", body: "Shared history" });

  await assert.rejects(() => a.deleteProjectMailbox("bob"), /active session mailbox/);
  await b.close();
  const deleted = await a.deleteProjectMailbox("bob");
  assert.equal(deleted.alias, "bob");
  assert.equal((await a.listProjectSessions({ includeInactive: true })).some((peer) => peer.id === b.sessionId), false);
  assert.equal(await a.store.getPeer(b.sessionId), null);
  await assert.rejects(() => a.send({ to: ["bob"], body: "Should fail" }), /Unknown recipient/);
  assert.ok((await a.listSent()).some((item) => item.id === message.id));

  const resumed = new MailService({ cwd, sessionId: b.sessionId, runtimeId: "runtime-b-resumed", presenceTtlMs: 60_000 });
  await resumed.init();
  assert.equal((await inbox(resumed)).length, 0);
  assert.ok((await a.discover()).some((peer) => peer.id === b.sessionId));
});

test("a new session identity in the same project starts with an independent mailbox", async () => {
  const { cwd, a, b } = await makeServices();
  await a.send({ to: ["bob"], body: "Only Bob should receive this." });

  const fork = new MailService({
    cwd,
    sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    runtimeId: "runtime-fork",
    presenceTtlMs: 60_000,
  });
  await fork.init({ alias: "fork" });

  assert.equal((await inbox(fork)).length, 0);
  assert.ok((await fork.discover()).some((peer) => peer.id === b.sessionId));
});

test("wait returns immediately when unpresented mail already exists", async () => {
  const { a, b } = await makeServices();
  const sent = await a.send({ to: ["bob"], subject: "Already here", body: "Do not wait past this." });

  const result = await b.waitForInbox({ timeoutMs: 1_000 });
  assert.equal(result.reason, "pending");
  assert.equal(result.messages[0].id, sent.id);
  assert.ok(result.waitedMs < 500);
  assert.equal((await b.store.getDelivery(b.sessionId, sent.id))?.presentedAt, null);
});

test("wait detects a delivery that arrives after waiting begins", async () => {
  const { a, b } = await makeServices();
  const waiting = b.waitForInbox({ timeoutMs: 1_000 });

  await new Promise((resolve) => setTimeout(resolve, 40));
  const sent = await a.send({ to: ["bob"], subject: "Later", body: "Arrived while waiting." });
  const result = await waiting;

  assert.equal(result.reason, "new");
  assert.equal(result.messages[0].id, sent.id);
});

test("wait has a finite timeout and returns control", async () => {
  const { b } = await makeServices();
  const result = await b.waitForInbox({ timeoutMs: 40 });
  assert.equal(result.reason, "timeout");
  assert.deepEqual(result.messages, []);
  assert.ok(result.waitedMs >= 30);
});

test("mail views include creation timestamps while keeping previews bounded", async () => {
  const { a } = await makeServices();
  const body = "x".repeat(BODY_PREVIEW_CHARS + 100);
  const message = await a.send({ to: ["bob"], subject: "Long body", body });

  const listText = formatToolContent("inbox", [message]);
  const fullText = formatToolContent("inbox", message);
  const threadText = formatToolContent("thread", [message]);
  const sentText = formatToolContent("sent", await a.listSent());
  const waitText = formatToolContent("wait", {
    reason: "pending",
    waitedMs: 0,
    messages: [message],
  });

  for (const text of [listText, fullText, threadText, sentText, waitText]) {
    assert.match(text, new RegExp(message.createdAt.replaceAll(".", "\\.")));
  }
  assert.ok(listText.length < fullText.length);
  assert.match(listText, /…/);
  assert.match(threadText, /…/);
  assert.ok(fullText.includes(body));
  assert.equal(fullText.match(new RegExp(message.id, "g"))?.length, 1);
  assert.doesNotMatch(fullText, /Message-ID:|Thread:/);
  assert.match(threadText, /^Thread · 1 message\n/);

  const notifying = { ...message, notify: true };
  const injectedText = formatPeerMailContent(notifying);
  assert.equal(injectedText.match(new RegExp(message.id, "g"))?.length, 1);
  assert.doesNotMatch(injectedText, /thread_id=/);
});

test("status presentation validates canonical and restored legacy reminder details", () => {
  const base = {
    id: "session",
    shortId: "session",
    alias: "mailbox",
    sessionName: null,
    discoverable: true,
    mailRoot: "/mail",
    unpresented: { to: 0, cc: 0 },
    activePeerCount: 0,
  };

  const valid = formatToolContent("status", {
    ...base,
    reminder: { mode: "after-minutes", minutes: 30, source: "project" },
  });
  const legacy = formatToolContent("status", { ...base, reminderAfterMinutes: 30 });
  const missingMinutes = formatToolContent("status", {
    ...base,
    reminder: { mode: "after-minutes", source: "project" },
  });
  const invalidCanonical = formatToolContent("status", {
    ...base,
    reminder: { mode: "after-minutes", minutes: 1441, source: "global" },
  });
  const invalidLegacy = formatToolContent("status", { ...base, reminderAfterMinutes: 1441 });

  assert.match(valid, /Reminder: 30m \(project\)/);
  assert.match(legacy, /Reminder: 30m \(mailbox\)/);
  for (const text of [missingMinutes, invalidCanonical, invalidLegacy]) {
    assert.match(text, /Reminder: off \(built-in\)/);
    assert.doesNotMatch(text, /undefinedm|1441m/);
  }
});

test("Pi Mail 0.1 messages without senderKind remain session-origin messages", async () => {
  const { a, b } = await makeServices();
  const createdAt = new Date().toISOString();
  const id = "legacy-message";

  await a.store.tryCreateMessage({
    version: 1,
    id,
    from: a.sessionId,
    fromAlias: "alice",
    to: [b.sessionId],
    cc: [],
    subject: "Legacy",
    body: "Written by Pi Mail 0.1",
    threadId: id,
    inReplyTo: null,
    createdAt,
  });
  await a.store.putDelivery({
    version: 1,
    messageId: id,
    recipientId: b.sessionId,
    kind: "to",
    deliveredAt: createdAt,
    presentedAt: null,
  });

  const message = (await inbox(b)).find((item) => item.id === id);
  assert.equal(message?.senderKind, "session");
  assert.equal(message?.notify, false);
  assert.ok((await a.listSent()).some((item) => item.id === id));
});

test("linked Git worktrees resolve to one canonical project root", async (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git is not available");
    return;
  }

  const base = await mkdtemp(path.join(os.tmpdir(), "pi-mail-git-"));
  const repo = path.join(base, "repo");
  const worktree = path.join(base, "worktree");

  execFileSync("git", ["init", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Pi Mail Test"]);
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", "test-worktree", worktree], { stdio: "ignore" });

  assert.equal(resolveProjectRoot(repo), path.resolve(repo));
  assert.equal(resolveProjectRoot(worktree), path.resolve(repo));
});


test("mailbox override wins over defaults and clearing it restores inheritance", async () => {
  const { cwd, b } = await makeServices();
  assert.deepEqual(await b.getEffectiveReminder(), { policy: { kind: "off" }, source: "built-in" });

  await b.configureReminder({ kind: "after-minutes", minutes: 30 });
  assert.deepEqual(await b.getEffectiveReminder(), { policy: { kind: "after-minutes", minutes: 30 }, source: "mailbox" });

  const resumed = new MailService({
    cwd,
    sessionId: b.sessionId,
    runtimeId: "runtime-b-reminder-resume",
    presenceTtlMs: 60_000,
    defaultReminder: { policy: { kind: "after-turn" }, source: "project" },
  });
  await resumed.init();
  assert.deepEqual(await resumed.getEffectiveReminder(), { policy: { kind: "after-minutes", minutes: 30 }, source: "mailbox" });
  await resumed.configureReminder(undefined);
  assert.deepEqual(await resumed.getEffectiveReminder(), { policy: { kind: "after-turn" }, source: "project" });
  await resumed.configureReminder({ kind: "off" });
  assert.deepEqual(await resumed.getEffectiveReminder(), { policy: { kind: "off" }, source: "mailbox" });
});

test("legacy peers decode conservatively and current writes use version 2", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-peer-v1-"));
  const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const service = new MailService({
    cwd,
    sessionId,
    runtimeId: "runtime-peer-v1",
    defaultReminder: { policy: { kind: "after-turn" }, source: "global" },
  });
  await service.store.init();
  const timestamp = new Date().toISOString();
  const file = path.join(service.root, "peers", `${sessionId}.json`);
  await writeFile(file, JSON.stringify({
    version: 1,
    id: sessionId,
    alias: "legacy",
    cwd,
    discoverable: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));

  await service.init();
  assert.deepEqual(await service.getEffectiveReminder(), { policy: { kind: "off" }, source: "mailbox" });
  const stored = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal(stored.version, 2);
  assert.equal(stored.reminder, "off");
  assert.equal(Object.hasOwn(stored, "reminderAfterMinutes"), false);
});

test("malformed and unknown peer versions fail with the peer path", async () => {
  const { b } = await makeServices();
  const file = path.join(b.root, "peers", `${b.sessionId}.json`);
  const current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

  await writeFile(file, JSON.stringify({ ...current, version: 2, reminder: null }));
  await assert.rejects(() => b.store.getPeer(b.sessionId), (error: Error) => error.message.includes(file) && /Reminder must/.test(error.message));

  await writeFile(file, JSON.stringify({ ...current, version: 99 }));
  await assert.rejects(() => b.store.getPeer(b.sessionId), (error: Error) => error.message.includes(file) && /unsupported version 99/.test(error.message));
});

test("v2 peers reject legacy reminder fields even when a canonical override exists", async () => {
  const { b } = await makeServices();
  const file = path.join(b.root, "peers", `${b.sessionId}.json`);
  const current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({
    ...current,
    version: 2,
    reminder: "off",
    reminderAfterMinutes: 30,
  }));
  await assert.rejects(
    () => b.store.getPeer(b.sessionId),
    (error: Error) => error.message.includes(file) && /must not contain legacy reminderAfterMinutes/.test(error.message),
  );
});

test("bounded inbox reads present only returned deliveries", async () => {
  const { a, b } = await makeServices();
  const first = await a.send({ to: ["bob"], body: "first" });
  const second = await a.send({ to: ["bob"], body: "second" });
  const returned = await b.listInbox({ limit: 1, markPresented: true }) as MailMessage[];
  assert.equal(returned.length, 1);
  const deliveries = await Promise.all([first.id, second.id].map((id) => b.store.getDelivery(b.sessionId, id)));
  assert.equal(deliveries.filter((delivery) => delivery?.presentedAt).length, 1);
  assert.equal((await b.listUnpresentedForAttention()).length, 1);
});

test("recipient delivery time is recorded when each delivery is created", async () => {
  const { a, b } = await makeServices();
  const before = Date.now();
  const message = await a.send({ to: ["bob"], body: "timestamp" });
  const delivery = await b.store.getDelivery(b.sessionId, message.id);
  assert.ok(delivery);
  assert.ok(Date.parse(delivery.deliveredAt) >= before);
  assert.ok(Date.parse(delivery.deliveredAt) >= Date.parse(message.createdAt));
});

test("concurrent peer updates preserve session name and reminder fields", async () => {
  const { b } = await makeServices();
  const putPeer = b.store.putPeer.bind(b.store);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let firstWrite = true;
  b.store.putPeer = async (peer) => {
    if (firstWrite) {
      firstWrite = false;
      await blocked;
    }
    await putPeer(peer);
  };

  const naming = b.syncSessionName("Concurrent review");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const reminder = b.configureReminder({ kind: "after-turn" });
  release();
  await Promise.all([naming, reminder]);

  const peer = await b.store.getPeer(b.sessionId);
  assert.equal(peer?.sessionName, "Concurrent review");
  assert.equal(peer?.reminder, "after-turn");
});

test("reminder writes validate at the service boundary and no-op updates do not rewrite peers", async () => {
  const { b } = await makeServices();
  const before = await b.store.getPeer(b.sessionId);
  await b.configureReminder(undefined);
  assert.equal((await b.store.getPeer(b.sessionId))?.updatedAt, before?.updatedAt);
  await assert.rejects(
    () => b.configureReminder({ kind: "after-minutes", minutes: 0 }),
    /Reminder must be/,
  );
  assert.deepEqual(await b.getEffectiveReminder(), { policy: { kind: "off" }, source: "built-in" });
});

test("status counts the complete unpresented mailbox beyond display limits", async () => {
  const { a, b } = await makeServices();
  const createdAt = new Date().toISOString();
  for (let index = 0; index < 101; index += 1) {
    const id = `bulk${String(index).padStart(3, "0")}`;
    await a.store.tryCreateMessage({
      version: 1,
      id,
      senderKind: "session",
      from: a.sessionId,
      fromAlias: "alice",
      to: [b.sessionId],
      cc: [],
      subject: id,
      body: id,
      notify: false,
      threadId: id,
      inReplyTo: null,
      createdAt,
    });
    await a.store.putDelivery({
      version: 1,
      messageId: id,
      recipientId: b.sessionId,
      kind: "to",
      deliveredAt: createdAt,
      presentedAt: null,
    });
  }
  assert.equal((await b.status()).unpresented.to, 101);
});

test("project mailbox overview distinguishes self, explicit override, and unobservable inheritance", async () => {
  const { a, b, c } = await makeServices();
  const direct = await a.send({ to: ["bob"], cc: ["carol"], body: "state" });
  await b.configureReminder({ kind: "after-minutes", minutes: 30 });

  const overviews = await a.listProjectMailboxes({ includeInactive: true });
  const alice = overviews.find((mailbox) => mailbox.id === a.sessionId);
  const bob = overviews.find((mailbox) => mailbox.id === b.sessionId);
  const carol = overviews.find((mailbox) => mailbox.id === c.sessionId);
  assert.deepEqual(alice?.reminder, { mode: "off", source: "built-in" });
  assert.equal(bob?.pending.to, 1);
  assert.equal(bob?.pending.cc, 0);
  assert.ok(bob?.pending.oldestToAt);
  assert.deepEqual(bob?.reminder, { mode: "after-minutes", minutes: 30, source: "mailbox" });
  assert.equal(carol?.pending.to, 0);
  assert.equal(carol?.pending.cc, 1);
  assert.equal(carol?.pending.oldestToAt, null);
  assert.equal(carol?.reminder, null);
  assert.equal((await b.store.getDelivery(b.sessionId, direct.id))?.presentedAt, null);
});
