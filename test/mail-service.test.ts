import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HUMAN_PRINCIPAL_ID, MailService } from "../extensions/pi-mail/mail-service.ts";
import { mailboxNoticeBucket, shouldInterruptForPeerMail } from "../extensions/pi-mail/attention-policy.ts";
import { resolveProjectRoot } from "../extensions/pi-mail/project-root.ts";
import { BODY_PREVIEW_CHARS, formatToolContent } from "../extensions/pi-mail/tool-presentation.ts";
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
  assert.deepEqual([0, 1, 2, 3, 5, 6].map(mailboxNoticeBucket), [0, 0, 0, 1, 1, 2]);
});

test("sending to an inactive historical mailbox succeeds and reports it inactive", async () => {
  const { a, b } = await makeServices();
  await b.close();

  const message = await a.send({ to: ["bob"], subject: "Offline", body: "Read this after resume." });
  const recipients = await a.recipientStatusesFor(message.id);

  assert.equal(recipients[0].active, false);
  assert.equal((await inbox(b))[0].id, message.id);
});

test("message references accept unambiguous ID prefixes", async () => {
  const { a, b } = await makeServices();

  const first = await a.send({
    to: ["bob"],
    subject: "Prefix lookup",
    body: "Use the displayed short ID to reply.",
  });

  const read = await b.listInbox({ messageId: first.shortId, markPresented: false }) as MailMessage;
  assert.equal(read.id, first.id);

  const reply = await b.send({ replyTo: first.shortId, body: "Short ID resolved." });
  assert.equal(reply.inReplyTo, first.id);
  assert.equal((await a.thread(reply.shortId)).length, 2);
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

test("inbox and thread tool text use bounded body previews", async () => {
  const { a } = await makeServices();
  const body = "x".repeat(BODY_PREVIEW_CHARS + 100);
  const message = await a.send({ to: ["bob"], subject: "Long body", body });

  const listText = formatToolContent("inbox", [message]);
  const fullText = formatToolContent("inbox", message);
  const threadText = formatToolContent("thread", [message]);

  assert.ok(listText.length < fullText.length);
  assert.match(listText, /…/);
  assert.match(threadText, /…/);
  assert.ok(fullText.includes(body));
});

test("Pi Mail 0.1 messages without senderKind remain session-origin messages", async () => {
  const { a, b } = await makeServices();
  const createdAt = new Date().toISOString();
  const id = "legacy-message";

  await a.store.putMessage({
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
