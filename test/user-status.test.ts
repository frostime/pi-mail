import assert from "node:assert/strict";
import test from "node:test";

import { formatUserStatus } from "../extensions/pi-mail/tool-presentation.ts";
import type { MailStatus } from "../extensions/pi-mail/types.ts";

function status(overrides: Partial<MailStatus> = {}): MailStatus {
  return {
    id: "session-1",
    shortId: "a1b2c3d4",
    alias: "dev-agent",
    sessionName: null,
    discoverable: true,
    reminder: { mode: "off", source: "built-in" },
    mailRoot: "/tmp/mails",
    unpresented: { to: 2, cc: 1 },
    activePeerCount: 3,
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-14T12:00:00Z");

test("user status shows mailbox name, id, counts, and reminder", () => {
  const text = formatUserStatus(
    status({ reminder: { mode: "after-minutes", minutes: 30, source: "project" } }),
    null,
    NOW,
  );
  assert.match(text, /^Pi Mail mailbox: dev-agent \(a1b2c3d4\)/);
  assert.match(text, /Discoverable: yes · Active peers: 3/);
  assert.match(text, /Inbox: 2 To, 1 Cc pending$/m);
  assert.match(text, /Reminder: 30 minutes \(project default\)\./);
  assert.equal(text.split("\n").length, 4);
});

test("user status appends the session name when it differs from the alias", () => {
  const text = formatUserStatus(status({ sessionName: "Pi · /project" }), null, NOW);
  assert.match(text, /^Pi Mail mailbox: dev-agent \(a1b2c3d4\) · Pi · \/project/);
});

test("user status reports the oldest waiting direct mail age", () => {
  const delivered = new Date(NOW - 35 * 60_000).toISOString();
  const text = formatUserStatus(status(), delivered, NOW);
  assert.match(text, /Inbox: 2 To, 1 Cc pending · oldest direct mail waiting 35m$/m);
});

test("user status omits the age clause when no direct mail is pending", () => {
  const text = formatUserStatus(status(), null, NOW);
  assert.match(text, /Inbox: 2 To, 1 Cc pending$/m);
  assert.doesNotMatch(text, /waiting/);
});

test("user status formats waiting ages in hours and days", () => {
  const hours = new Date(NOW - 2 * 3_600_000 - 5 * 60_000).toISOString();
  assert.match(formatUserStatus(status(), hours, NOW), /oldest direct mail waiting 2h 5m/);
  const days = new Date(NOW - 3 * 86_400_000 - 4 * 3_600_000).toISOString();
  assert.match(formatUserStatus(status(), days, NOW), /oldest direct mail waiting 3d 4h/);
  const fresh = new Date(NOW - 20_000).toISOString();
  assert.match(formatUserStatus(status(), fresh, NOW), /oldest direct mail waiting under a minute/);
});
