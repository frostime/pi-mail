import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import piMailExtension from "../extensions/pi-mail/index.ts";
import { FsMailStore } from "../extensions/pi-mail/fs-store.ts";
import { resolveMailRoot } from "../extensions/pi-mail/project-root.ts";

const SESSION_ID = "019c1234-5678-7000-8000-123456789abc";

type EventHandler = (event: any, ctx: ExtensionContext) => Promise<void> | void;

function extensionHarness() {
  const handlers = new Map<string, EventHandler>();
  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
    registerTool() {},
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
  };
}

function sessionContext(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    isProjectTrusted: () => false,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => SESSION_ID,
      getEntries: () => [],
    },
    ui: {
      notify() {},
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
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
