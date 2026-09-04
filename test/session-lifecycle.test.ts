import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import piMailExtension from "../extensions/pi-mail/index.ts";
import { FsMailStore } from "../extensions/pi-mail/fs-store.ts";
import { resolveMailRoot } from "../extensions/pi-mail/project-root.ts";

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

    const store = new FsMailStore(resolveMailRoot(cwd));
    assert.equal((await store.listPresence()).length, 1);

    await extension.emit("session_info_changed", { name: "Renamed session" }, sessionContext(cwd));
    assert.equal((await store.getPeer(SESSION_ID))?.sessionName, "Renamed session");

    await extension.emit("session_shutdown", { reason: "reload" }, shutdownCtx);
    assert.equal((await store.listPresence()).length, 0);
    assert.equal((await store.getPeer(SESSION_ID))?.provisional, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session exit removes a mailbox that was never meaningfully used", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-mail-unused-lifecycle-"));
  try {
    const extension = extensionHarness();
    await extension.emit("session_start", { reason: "startup" }, sessionContext(cwd));

    const store = new FsMailStore(resolveMailRoot(cwd));
    assert.equal((await store.getPeer(SESSION_ID))?.provisional, true);

    await extension.emit("session_shutdown", { reason: "quit" }, sessionContext(cwd));

    assert.equal(await store.getPeer(SESSION_ID), null);
    assert.equal((await store.listPresence()).length, 0);
    await assert.rejects(access(resolveMailRoot(cwd)), { code: "ENOENT" });
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
    await assert.rejects(access(resolveMailRoot(cwd)), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unused mailbox cleanup preserves unknown files in the Mail store", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-mail-unknown-store-file-"));
  try {
    const extension = extensionHarness();
    await extension.emit("session_start", { reason: "startup" }, sessionContext(cwd));
    const unknownFile = path.join(resolveMailRoot(cwd), "keep.txt");
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
    const unknownFile = path.join(store.root, "mailboxes", SESSION_ID, "keep.txt");
    await mkdir(path.dirname(unknownFile), { recursive: true });
    await writeFile(unknownFile, "keep\n");

    await extension.emit("session_shutdown", { reason: "quit" }, sessionContext(cwd));

    assert.equal(await readFile(unknownFile, "utf8"), "keep\n");
    assert.equal((await store.getPeer(SESSION_ID))?.provisional, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an unavailable project store disables Mail without failing session startup", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-mail-unavailable-store-"));
  const notifications: Array<{ message: string; level: string }> = [];
  try {
    await writeFile(path.join(cwd, ".pi"), "not a directory");

    const extension = extensionHarness();
    await extension.emit("session_start", { reason: "startup" }, sessionContext(cwd, notifications));

    assert.deepEqual(notifications.map(({ level }) => level), ["warning"]);
    assert.match(notifications[0].message, /Pi Mail disabled: cannot write to .*\(ENOTDIR\)\./);
    await assert.rejects(
      extension.executeMail({ action: "status" }),
      /Pi Mail disabled: cannot write to .*\(ENOTDIR\)\./,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("mailbox data errors still fail session startup", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-mail-invalid-store-"));
  try {
    const peerDirectory = path.join(resolveMailRoot(cwd), "peers");
    await mkdir(peerDirectory, { recursive: true });
    await writeFile(path.join(peerDirectory, `${SESSION_ID}.json`), "{invalid json");

    const extension = extensionHarness();
    await assert.rejects(
      extension.emit("session_start", { reason: "startup" }, sessionContext(cwd)),
      SyntaxError,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
