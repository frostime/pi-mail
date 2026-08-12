import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MailService } from "../extensions/pi-mail/mail-service.ts";
import { startWebUi } from "../extensions/pi-mail/web-ui.ts";
import type { MailMessage } from "../extensions/pi-mail/types.ts";

function authorization(url: string): { base: string; headers: Record<string, string> } {
  const parsed = new URL(url);
  const token = parsed.searchParams.get("token");
  assert.ok(token);
  return {
    base: parsed.origin,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
}

test("Web UI serves bilingual HTML and token-protected APIs", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-mail-web-"));
  const a = new MailService({ cwd, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", runtimeId: "runtime-a" });
  const b = new MailService({ cwd, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", runtimeId: "runtime-b" });
  await a.init({ alias: "alice" });
  await b.init({ alias: "bob" });

  const ui = await startWebUi(a);
  try {
    const html = await fetch(ui.url).then((response) => response.text());
    assert.match(html, /Compose as user/);
    assert.match(html, /以用户身份写信/);
    assert.match(html, /prefers-color-scheme/);
    assert.match(html, /To: all active/);

    const { base, headers } = authorization(ui.url);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);

    const state = await fetch(`${base}/api/state`, { headers }).then((response) => response.json()) as { peers: Array<{ id: string; self?: boolean }> };
    assert.equal(state.peers.length, 2);
    assert.equal(state.peers.filter((peer) => peer.self).length, 1);

    const sendResponse = await fetch(`${base}/api/send`, {
      method: "POST",
      headers,
      body: JSON.stringify({ to: [a.sessionId, b.sessionId], cc: [], subject: "From Web UI", body: "Human message" }),
    });
    assert.equal(sendResponse.status, 201);

    const aInbox = await a.listInbox({ markPresented: false }) as MailMessage[];
    const bInbox = await b.listInbox({ markPresented: false }) as MailMessage[];
    assert.equal(aInbox[0].senderKind, "human");
    assert.equal(bInbox[0].senderKind, "human");
    assert.equal(bInbox[0].subject, "From Web UI");

    const closeResponse = await fetch(`${base}/api/close`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(closeResponse.status, 200);
  } finally {
    await ui.close();
  }
});
