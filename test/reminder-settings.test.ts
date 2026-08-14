import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadReminderSettings } from "../extensions/pi-mail/reminder-settings.ts";

async function settingsFixture(globalValue: unknown, projectValue: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mail-settings-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ "ext::pi-mail": { reminder: globalValue } }));
  await writeFile(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ "ext::pi-mail": { reminder: projectValue } }));
  return { cwd, agentDir };
}

test("trusted project reminder overrides the global default", async () => {
  const { cwd, agentDir } = await settingsFixture(30, "after-turn");
  const loaded = loadReminderSettings(cwd, true, agentDir);
  assert.deepEqual(loaded.defaultReminder, { policy: { kind: "after-turn" }, source: "project" });
  assert.deepEqual(loaded.warnings, []);
});

test("untrusted projects do not contribute reminder settings", async () => {
  const { cwd, agentDir } = await settingsFixture(30, "after-turn");
  const loaded = loadReminderSettings(cwd, false, agentDir);
  assert.deepEqual(loaded.defaultReminder, { policy: { kind: "after-minutes", minutes: 30 }, source: "global" });
  assert.deepEqual(loaded.warnings, []);
});

test("an invalid project value warns once and falls through to global", async () => {
  const { cwd, agentDir } = await settingsFixture(15, "later");
  const loaded = loadReminderSettings(cwd, true, agentDir);
  assert.deepEqual(loaded.defaultReminder, { policy: { kind: "after-minutes", minutes: 15 }, source: "global" });
  assert.equal(loaded.warnings.length, 1);
  assert.equal(loaded.warnings[0].scope, "project");
});

test("malformed settings files produce bounded scope warnings", async () => {
  const { cwd, agentDir } = await settingsFixture("off", "off");
  await writeFile(path.join(agentDir, "settings.json"), "{bad json");
  await writeFile(path.join(cwd, ".pi", "settings.json"), "{bad json");
  const loaded = loadReminderSettings(cwd, true, agentDir);
  assert.deepEqual(loaded.defaultReminder, { policy: { kind: "off" }, source: "built-in" });
  assert.deepEqual(loaded.warnings.map((warning) => warning.scope), ["global", "project"]);
});

test("invalid settings fall back to the built-in off default", async () => {
  const { cwd, agentDir } = await settingsFixture(0, null);
  const loaded = loadReminderSettings(cwd, true, agentDir);
  assert.deepEqual(loaded.defaultReminder, { policy: { kind: "off" }, source: "built-in" });
  assert.deepEqual(loaded.warnings.map((warning) => warning.scope), ["project", "global"]);
});
