import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Isolate the ephemeral presence buckets this file creates away from the
// user's real ~/.pi directory.
process.env.PI_MAIL_PRESENCE_ROOT = await mkdtemp(path.join(tmpdir(), "pi-mail-presence-lifecycle-"));

import piMailExtension from "../extensions/pi-mail/index.ts";
import { FsMailStore } from "../extensions/pi-mail/fs-store.ts";
import { FsPresenceStore } from "../extensions/pi-mail/presence-store.ts";
import { resolveMailRoot, resolvePresenceRoot, resolveProjectRoot } from "../extensions/pi-mail/project-root.ts";

const SESSION_ID = "019c1234-5678-7000-8000-123456789abc";

type EventHandler = (event: any, ctx: ExtensionContext) => Promise<void> | void;
type MailTool = {
  execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
};

function extensionHarness() {
  const handlers = new Map<string, EventHandler>();
  let mailTool: MailTool | null = null;
  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
    registerTool(tool: MailTool & { name: string }) {
      if (tool.name === "mail") mailTool = tool;
    },
    getSessionName() {
      return "Initial session name";
    },
    sendMessage() {},
    sendUserMessage() {},
  } as unknown as ExtensionAPI;

  piMailExtension(pi);
  return {
    async emit(event: string, payload: Record<string, unknown>, ctx: ExtensionContext) {
      const handler = handlers.get(event);
      assert.ok(handler, `missing ${event} handler`);
      await handler({ type: event, ...payload }, ctx);
    },
    executeMail(params: Record<string, unknown>) {
      assert.ok(mailTool, "mail tool was not registered");
      return mailTool.execute("test-call", params, new AbortController().signal);
    },
  };
}

function sessionContext(
  cwd: string,
  notifications?: Array<{ message: string; level: string }>,
): ExtensionContext {
  return {
    cwd,
    hasUI: notifications !== undefined,
    isProjectTrusted: () => false,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => SESSION_ID,
      getEntries: () => [],
    },
    ui: {
      notify(message: string, level: string) {
        notifications?.push({ message, level });
      },
      setStatus() {},
    },
  } as unknown as ExtensionContext;
}

test("session shutdown disposes resources when Pi supplies a different context object", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-mail-lifecycle-"));
  try {
    const extension = extensionHarness();
    const startCtx = sessionContext(cwd);
    const shutdownCtx = sessionContext(cwd);
    assert.notEqual(startCtx, shutdownCtx);

    await extension.emit("session_start", { reason: "startup" }, startCtx);

    // Lazy store creation: session startup writes no project-side data at all.
    await assert.rejects(access(resolveMailRoot(cwd)), { code: "ENOENT" });

    const presenceStore = new FsPresenceStore(resolvePresenceRoot(cwd).root, resolveProjectRoot(cwd));
    assert.equal((await presenceStore.listPresence()).length, 1);

    await extension.emit("session_info_changed", { name: "Renamed session" }, sessionContext(cwd));
    const presence = (await presenceStore.listPresence())[0];
    assert.equal(presence.sessionName, "Renamed session");
    assert.equal(typeof presence.alias, "string");

    await extension.emit("session_shutdown", { reason: "reload" }, shutdownCtx);
    assert.equal((await presenceStore.listPresence()).length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session exit leaves no project data for a session that never used Mail", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-mail-unused-lifecycle-"));
  try {
    const extension = extensionHarness();
    await extension.emit("session_start", { reason: "startup" }, sessionContext(cwd));

    // No durable mail value was produced, so no project-side store exists.
    await assert.rejects(access(resolveMailRoot(cwd)), { code: "ENOENT" });
    await assert.rejects(access(path.join(cwd, ".pi")), { code: "ENOENT" });

    await extension.emit("session_shutdown", { reason: "quit" }, sessionContext(cwd));

    const presenceStore = new FsPresenceStore(resolvePresenceRoot(cwd).root, resolveProjectRoot(cwd));
    assert.equal((await presenceStore.listPresence()).length, 0);
    await assert.rejects(access(resolveMailRoot(cwd)), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cleanup removes a created store once it contains no mail data", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-mail-empty-store-cleanup-"));
  try {
    const store = new FsMailStore(resolveMailRoot(cwd));
    await store.init();

    assert.equal(await store.removeIfEmpty(), true);
    await assert.rejects(access(store.root), { code: "ENOENT" });
    await assert.rejects(access(path.join(cwd, ".pi")), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unused mailbox cleanup preserves unrelated project Pi data", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-mail-shared-pi-dir-"));
  const settingsFile = path.join(cwd, ".pi", "settings.json");
  try {
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, "{}\n");

    const extension = extensionHarness();
    await extension.emit("session_start", { reason: "startup" }, sessionContext(cwd));
    await extension.emit("session_shutdown", { reason: "quit" }, sessionContext(cwd));

    assert.equal(await readFile(settingsFile, "utf8"), "{}\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unused mailbox cleanup preserves unknown files in the Mail store", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-mail-unknown-store-file-"));
  try {
    const extension = extensionHarness();
    await extension.emit("session_start", { reason: "startup" }, sessionContext(cwd));

    // The store only exists after a durable write; create it the way Mail
    // would, then add an unrecognized file that cleanup must preserve.
    const store = new FsMailStore(resolveMailRoot(cwd));
    await store.init();
    const unknownFile = path.join(store.root, "keep.txt");
    await writeFile(unknownFile, "keep\n");

    await extension.emit("session_shutdown", { reason: "quit" }, sessionContext(cwd));

    assert.equal(await readFile(unknownFile, "utf8"), "keep\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unused mailbox cleanup preserves unknown mailbox contents", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-mail-unknown-mailbox-file-"));
  try {
    const extension = extensionHarness();
    await extension.emit("session_start", { reason: "startup" }, sessionContext(cwd));
    const store = new FsMailStore(resolveMailRoot(cwd));
    await store.init();
    const unknownFile = path.join(store.root, "mailboxes", SESSION_ID, "keep.txt");
    await mkdir(path.dirname(unknownFile), { recursive: true });
    await writeFile(unknownFile, "keep\n");

    await extension.emit("session_shutdown", { reason: "quit" }, sessionContext(cwd));

    assert.equal(await readFile(unknownFile, "utf8"), "keep\n");
    const presenceStore = new FsPresenceStore(resolvePresenceRoot(cwd).root, resolveProjectRoot(cwd));
    assert.equal((await presenceStore.listPresence()).length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an unavailable project store surfaces on the first mail write", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-mail-unavailable-store-"));
  const notifications: Array<{ message: string; level: string }> = [];
  try {
    await writeFile(path.join(cwd, ".pi"), "not a directory");

    const extension = extensionHarness();
    // Lazy creation means startup is unaffected by project storage problems.
    await extension.emit("session_start", { reason: "startup" }, sessionContext(cwd, notifications));
    assert.deepEqual(notifications, []);

    // Reads tolerate the blocked store silently (an empty mailbox is returned);
    // the disable error appears on the first durable write.
    await extension.executeMail({ action: "status" });
    await assert.rejects(
      extension.executeMail({ action: "configure", alias: "probed" }),
      /Pi Mail disabled: cannot write to .*\(ENOTDIR\)\./,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("malformed peer data surfaces through Mail use without failing session startup", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-mail-invalid-store-"));
  try {
    const peerDirectory = path.join(resolveMailRoot(cwd), "peers");
    await mkdir(peerDirectory, { recursive: true });
    await writeFile(path.join(peerDirectory, `${SESSION_ID}.json`), "{invalid json");

    const extension = extensionHarness();
    await extension.emit("session_start", { reason: "startup" }, sessionContext(cwd));
    await assert.rejects(
      extension.executeMail({ action: "status" }),
      SyntaxError,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
