import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Isolate the ephemeral presence buckets this file creates away from the
// user's real ~/.pi directory.
process.env.PI_MAIL_PRESENCE_ROOT = await mkdtemp(path.join(os.tmpdir(), "pi-mail-presence-mail-"));

import { HUMAN_PRINCIPAL_ID, MailService } from "../extensions/pi-mail/mail-service.ts";
import { shouldInterruptForPeerMail } from "../extensions/pi-mail/attention-policy.ts";
import { FsPresenceStore } from "../extensions/pi-mail/presence-store.ts";
import { resolvePresenceRoot, resolveProjectRoot } from "../extensions/pi-mail/project-root.ts";
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

test("initialization makes the entire mails directory ignored", async () => {
  const { a } = await makeServices();
  const text = await readFile(path.join(a.root, ".gitignore"), "utf8");
  assert.equal(text, "# Pi Mail runtime data\n*\n");
});

test("a session without durable mail writes creates no project-side store", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-lazy-store-"));
  const service = new MailService({
    cwd,
    sessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    runtimeId: "runtime-lazy",
    presenceRoot: { root: path.join(cwd, "presence-bucket"), projectRoot: cwd },
  });

  // Presence-only activity must not create the project store.
  await service.heartbeat();
  assert.equal(await service.store.getPeer(service.sessionId), null);
  await assert.rejects(access(path.join(cwd, ".pi")), { code: "ENOENT" });

  // Read-only use keeps working without the store.
  const status = await service.status();
  assert.match(status.alias, /^S\d{3}$/);
  assert.deepEqual((await service.discover()), []);
  assert.deepEqual((await service.waitForInbox({ timeoutMs: 0 })).messages, []);

  // Session-name sync stays ephemeral too.
  await service.syncSessionName("Lazy session");
  assert.equal((await service.presenceStore.listPresence())[0]?.sessionName, "Lazy session");
  await assert.rejects(access(path.join(cwd, ".pi")), { code: "ENOENT" });

  // Explicit configuration is a durable write and creates the store.
  await service.configure({ alias: "lazy" });
  assert.ok(await service.store.getPeer(service.sessionId));
  assert.ok(fsSync.existsSync(path.join(cwd, ".pi", "mails", ".gitignore")));
});

test("heartbeat advertises identity so peers can discover and address an unregistered session", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-lazy-discover-"));
  const presenceRoot = { root: path.join(cwd, "presence-bucket"), projectRoot: cwd };
  const registered = new MailService({
    cwd,
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    runtimeId: "runtime-registered",
    presenceTtlMs: 60_000,
    presenceRoot,
  });
  const fresh = new MailService({
    cwd,
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    runtimeId: "runtime-fresh",
    presenceTtlMs: 60_000,
    presenceRoot,
  });

  await registered.init({ alias: "registrar" });
  // The fresh session only heartbeats; it has no peer record.
  await fresh.syncSessionName("Fresh review");
  assert.equal(await fresh.store.getPeer(fresh.sessionId), null);

  const discovered = (await registered.discover()).find((peer) => peer.id === fresh.sessionId);
  assert.ok(discovered);
  assert.ok(discovered.alias.startsWith("S"));
  assert.equal(discovered.active, true);

  // Addressing by session ID works for the unregistered session...
  const sent = await registered.send({ to: [fresh.sessionId], body: "Addressed without registration." });
  // ...and the durable write created the store plus the recipient's record.
  assert.ok(fsSync.existsSync(path.join(cwd, ".pi", "mails")));
  assert.equal((await fresh.store.getPeer(fresh.sessionId))?.sessionName, "Fresh review");
  assert.ok((await inbox(fresh)).some((message) => message.id === sent.id));
});

test("multiple runtimes of one unregistered session resolve as one mailbox", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-shared-unregistered-"));
  const presenceRoot = { root: path.join(cwd, "presence-bucket"), projectRoot: cwd };
  const sender = new MailService({
    cwd,
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    runtimeId: "runtime-sender",
    presenceTtlMs: 60_000,
    presenceRoot,
  });
  const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const first = new MailService({ cwd, sessionId, runtimeId: "runtime-shared-a", presenceTtlMs: 60_000, presenceRoot });
  const second = new MailService({ cwd, sessionId, runtimeId: "runtime-shared-b", presenceTtlMs: 60_000, presenceRoot });

  await sender.init({ alias: "sender" });
  await first.heartbeat();
  await second.heartbeat();
  const address = (await first.status()).alias;
  const sent = await sender.send({
    to: [address, shortSessionId(sessionId)],
    body: "Both addresses identify one mailbox.",
  });

  assert.deepEqual(sent.to.map((recipient) => recipient.id), [sessionId]);
  assert.equal((await inbox(first))[0].id, sent.id);
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

test("a tombstoned session re-registers on its first durable write", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-tombstone-resume-"));
  const resumed = new MailService({
    cwd,
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    runtimeId: "runtime-resumed",
    presenceTtlMs: 60_000,
  });
  const recipient = new MailService({
    cwd,
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    runtimeId: "runtime-recipient",
    presenceTtlMs: 60_000,
  });
  await recipient.init({ alias: "recipient" });
  const timestamp = new Date().toISOString();
  await resumed.store.putPeer({
    version: 2,
    id: resumed.sessionId,
    alias: "resumed",
    cwd,
    discoverable: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: timestamp,
  });

  await resumed.send({ to: ["recipient"], body: "The mailbox is active again." });

  const peer = await resumed.store.getPeer(resumed.sessionId);
  assert.ok(peer);
  assert.equal(peer.alias, "resumed");
  assert.equal(Object.hasOwn(peer, "deletedAt"), false);
});

test("new sessions receive a compact generated alias and avoid collisions", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-generated-alias-"));
  const first = new MailService({ cwd, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaa000001", runtimeId: "runtime-generated-a" });
  const second = new MailService({ cwd, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbb000001", runtimeId: "runtime-generated-b" });

  assert.equal((await first.init()).alias, "S001");
  assert.equal((await second.init()).alias, "S002");
});

test("read-only mail use leaves a new mailbox temporary until it is configured", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-temporary-"));
  const service = new MailService({
    cwd,
    sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    runtimeId: "runtime-temporary",
  });

  await service.init();
  await service.status();
  await service.discover();
  await service.waitForInbox({ timeoutMs: 0 });
  assert.equal((await service.store.getPeer(service.sessionId))?.provisional, true);

  await service.configure({ discoverable: true });
  assert.equal(Object.hasOwn((await service.store.getPeer(service.sessionId))!, "provisional"), false);
});

test("sending mail makes both participating mailboxes durable", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-participation-"));
  const sender = new MailService({
    cwd,
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    runtimeId: "runtime-participation-a",
  });
  const recipient = new MailService({
    cwd,
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    runtimeId: "runtime-participation-b",
  });
  await sender.init();
  await recipient.init();

  await sender.send({ to: [recipient.sessionId], body: "Retain both mailboxes." });

  assert.equal(Object.hasOwn((await sender.store.getPeer(sender.sessionId))!, "provisional"), false);
  assert.equal(Object.hasOwn((await recipient.store.getPeer(recipient.sessionId))!, "provisional"), false);
});

test("shutdown discards an unused temporary mailbox but preserves one with legacy delivery", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-temporary-close-"));
  const unused = new MailService({
    cwd,
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    runtimeId: "runtime-unused",
  });
  const recipient = new MailService({
    cwd,
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    runtimeId: "runtime-legacy-recipient",
  });
  await unused.init();
  await recipient.init();

  const createdAt = new Date().toISOString();
  await recipient.store.putDelivery({
    version: 1,
    messageId: "legacy-delivery",
    recipientId: recipient.sessionId,
    kind: "to",
    deliveredAt: createdAt,
    presentedAt: null,
  });

  await unused.close({ discardUnusedMailbox: true });
  await recipient.close({ discardUnusedMailbox: true });

  assert.equal(await unused.store.getPeer(unused.sessionId), null);
  assert.equal(Object.hasOwn((await recipient.store.getPeer(recipient.sessionId))!, "provisional"), false);
  assert.ok(await recipient.store.getDelivery(recipient.sessionId, "legacy-delivery"));
});

test("temporary mailbox cleanup waits for the last active runtime", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-shared-runtime-"));
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const first = new MailService({ cwd, sessionId, runtimeId: "runtime-shared-a", presenceTtlMs: 60_000 });
  const second = new MailService({ cwd, sessionId, runtimeId: "runtime-shared-b", presenceTtlMs: 60_000 });
  await first.init();
  await second.init();

  await first.close({ discardUnusedMailbox: true });
  assert.equal((await first.store.getPeer(sessionId))?.provisional, true);

  await second.close({ discardUnusedMailbox: true });
  assert.equal(await second.store.getPeer(sessionId), null);
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

test("deleting a recipient mailbox preserves mail still owned by the sender", async () => {
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
  await resumed.heartbeat();
  assert.equal(await resumed.store.getPeer(resumed.sessionId), null);
  assert.equal((await inbox(resumed)).length, 0);
  assert.ok((await a.discover()).some((peer) => peer.id === b.sessionId));
});

test("deleting a sender mailbox preserves mail still owned by a recipient", async () => {
  const { a, b, c } = await makeServices();
  const message = await a.send({ to: ["bob"], body: "Recipient still owns this." });

  await a.close();
  const result = await c.deleteProjectMailboxes([a.sessionId]);

  assert.equal(result.gc.deletedCount, 0);
  assert.ok(await c.store.getMessage(message.id));
  assert.equal((await inbox(b))[0].id, message.id);
});

test("deleting every owning mailbox garbage-collects the canonical message", async () => {
  const { a, b, c } = await makeServices();
  const message = await a.send({ to: ["bob"], body: "No owner remains." });

  await a.close();
  await b.close();
  const result = await c.deleteProjectMailboxes([a.sessionId, b.sessionId]);

  assert.deepEqual(result.mailboxes.map((mailbox) => mailbox.alias), ["alice", "bob"]);
  assert.equal(result.gc.deletedCount, 1);
  assert.equal(await c.store.getMessage(message.id), null);
});

test("To/Cc fan-out keeps a message until the last owning mailbox is deleted", async () => {
  const { cwd, a, b, c } = await makeServices();
  const message = await a.send({ to: ["bob"], cc: ["carol"], body: "Shared fan-out." });
  const supervisor = new MailService({
    cwd,
    sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    runtimeId: "runtime-supervisor",
    presenceTtlMs: 60_000,
  });
  await supervisor.init({ alias: "dana" });

  await a.close();
  await b.close();
  const first = await supervisor.deleteProjectMailboxes([a.sessionId, b.sessionId]);
  assert.equal(first.gc.deletedCount, 0);
  assert.ok(await supervisor.store.getMessage(message.id));

  await c.close();
  const last = await supervisor.deleteProjectMailboxes([c.sessionId]);
  assert.equal(last.gc.deletedCount, 1);
  assert.equal(await supervisor.store.getMessage(message.id), null);
});

test("human-origin mail is collected after its last session recipient is deleted", async () => {
  const { a, b } = await makeServices();
  const message = await a.sendAsHuman({ to: ["bob"], body: "Human-owned only through Bob." });

  await b.close();
  const result = await a.deleteProjectMailboxes([b.sessionId]);

  assert.equal(result.gc.deletedCount, 1);
  assert.equal(await a.store.getMessage(message.id), null);
});

test("human-origin mail survives while any session recipient mailbox remains", async () => {
  const { a, b, c } = await makeServices();
  const message = await a.sendAsHuman({ to: ["bob", "carol"], body: "Carol still owns this." });

  await b.close();
  const result = await a.deleteProjectMailboxes([b.sessionId]);

  assert.equal(result.gc.deletedCount, 0);
  assert.ok(await a.store.getMessage(message.id));
  assert.equal((await inbox(c))[0].id, message.id);
});

test("tombstoned peers are not message GC roots", async () => {
  const { a, b } = await makeServices();
  const peer = await a.store.getPeer(b.sessionId);
  assert.ok(peer);
  await a.store.putPeer({ ...peer, deletedAt: new Date().toISOString() });
  await a.store.removeMailbox(b.sessionId);

  const createdAt = new Date().toISOString();
  assert.equal(await a.store.tryCreateMessage({
    version: 1,
    id: "legacy1",
    senderKind: "session",
    from: b.sessionId,
    fromAlias: peer.alias,
    to: [],
    cc: [],
    subject: "Legacy orphan",
    body: "Tombstone must not retain this.",
    threadId: "legacy1",
    inReplyTo: null,
    createdAt,
  }), true);

  const result = await a.collectUnreferencedMessages();
  assert.equal(result.deletedCount, 1);
  assert.equal(await a.store.getMessage("legacy1"), null);
});

test("batch mailbox deletion validates all targets before mutation", async () => {
  const { a, b, c } = await makeServices();
  await b.close();

  await assert.rejects(
    () => a.deleteProjectMailboxes([b.sessionId, c.sessionId]),
    /active session mailbox/,
  );
  assert.ok(await a.store.getPeer(b.sessionId));
  assert.ok(await a.store.getPeer(c.sessionId));
});

test("batch mailbox deletion deduplicates session IDs", async () => {
  const { a, b } = await makeServices();
  await b.close();

  const result = await a.deleteProjectMailboxes([b.sessionId, b.sessionId]);
  assert.equal(result.mailboxes.length, 1);
  assert.equal(result.mailboxes[0].id, b.sessionId);
});

test("GC failure reports that mailbox deletion already completed", async () => {
  const { a, b } = await makeServices();
  await a.sendAsHuman({ to: ["bob"], body: "This message needs GC." });
  await b.close();

  a.store.removeMessage = async () => { throw new Error("simulated remove failure"); };
  await assert.rejects(
    () => a.deleteProjectMailboxes([b.sessionId]),
    /Mailboxes deleted, but message cleanup failed: simulated remove failure/,
  );
  assert.equal(await a.store.getPeer(b.sessionId), null);
});

test("mailbox overview exposes the last mail activity time for inactive sessions", async () => {
  const { a, b, c } = await makeServices();
  const message = await a.send({ to: ["bob"], body: "Activity marker" });

  await a.close();
  await b.close();
  const overview = await c.listProjectMailboxes({ includeInactive: true });
  const alice = overview.find((peer) => peer.alias === "alice");
  const bob = overview.find((peer) => peer.alias === "bob");

  assert.ok(alice);
  assert.ok(bob);
  assert.ok(alice.lastMailAt);
  assert.ok(bob.lastMailAt);
  // Both directions point at the same exchange: sender-side message and recipient-side delivery.
  assert.ok(Date.parse(alice.lastMailAt) >= Date.parse(message.createdAt));
  assert.ok(Date.parse(bob.lastMailAt) >= Date.parse(message.createdAt));
  // A session that never joined any mail exchange has no activity timestamp.
  const carol = overview.find((peer) => peer.alias === "carol");
  assert.ok(carol);
  assert.equal(carol.lastMailAt, null);
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

test("presence buckets converge for the same project reached through a junction", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "pi-mail-junction-"));
  const project = path.join(base, "project");
  const link = path.join(base, "ongoing");

  fsSync.mkdirSync(project, { recursive: true });
  try {
    execFileSync("cmd", ["/c", "mklink", "/J", link, project], { stdio: "ignore" });
  } catch {
    t.skip("junction creation is unavailable");
    return;
  }

  const direct = resolvePresenceRoot(project);
  const aliased = resolvePresenceRoot(link);
  assert.equal(direct.root, aliased.root);
  assert.equal(direct.projectRoot, aliased.projectRoot);
});

test("stale presence files are swept without touching live heartbeats", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "pi-mail-sweep-"));
  const store = new FsPresenceStore(path.join(base, "bucket"), base);
  const liveId = "11111111-1111-4111-8111-111111111111";
  const staleId = "22222222-2222-4222-8222-222222222222";
  const oldTimestamp = new Date(Date.now() - 600_000).toISOString();
  const newTimestamp = new Date().toISOString();

  await store.putPresence({
    version: 1,
    sessionId: liveId,
    runtimeId: "runtime-live",
    pid: 1,
    cwd: base,
    startedAt: newTimestamp,
    lastSeenAt: newTimestamp,
  });
  await store.putPresence({
    version: 1,
    sessionId: staleId,
    runtimeId: "runtime-stale",
    pid: 2,
    cwd: base,
    startedAt: oldTimestamp,
    lastSeenAt: oldTimestamp,
  });
  // Backdate the stale heartbeat file; mtime is the sweep's liveness signal.
  const staleFile = path.join(store.root, staleId, "runtime-stale.json");
  const staleTime = new Date(Date.now() - 600_000);
  fsSync.utimesSync(staleFile, staleTime, staleTime);

  await store.sweepStale(300_000);

  const remaining = await store.listPresence();
  assert.deepEqual(remaining.map((presence) => presence.sessionId), [liveId]);
  await assert.rejects(access(path.join(store.root, staleId)), { code: "ENOENT" });
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

  await service.close({ discardUnusedMailbox: true });
  assert.ok(await service.store.getPeer(sessionId));
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

test("durable writes normalize storage availability errors", async () => {
  const { a } = await makeServices();
  a.store.tryCreateMessage = async () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  };

  await assert.rejects(
    () => a.send({ to: ["bob"], body: "This write cannot complete." }),
    /Pi Mail disabled: cannot write to .*\(ENOSPC\)\./,
  );
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
