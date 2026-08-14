import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { parseReminderPolicy, type ReminderPolicy } from "./attention-policy.ts";

export const PI_MAIL_SETTINGS_NAMESPACE = "npm:pi-mail";
export const PI_MAIL_REMINDER_SETTING = "reminder";

export type ReminderDefaultSource = "project" | "global" | "built-in";

export interface ReminderDefault {
  policy: ReminderPolicy;
  source: ReminderDefaultSource;
}

export interface ReminderSettingsWarning {
  scope: "project" | "global";
  message: string;
}

export interface LoadedReminderSettings {
  defaultReminder: ReminderDefault;
  warnings: ReminderSettingsWarning[];
}

function reminderValue(settings: unknown): { defined: boolean; value?: unknown } {
  if (typeof settings !== "object" || settings === null) return { defined: false };
  const namespace = (settings as Record<string, unknown>)[PI_MAIL_SETTINGS_NAMESPACE];
  if (namespace === undefined) return { defined: false };
  if (typeof namespace !== "object" || namespace === null || Array.isArray(namespace)) {
    return { defined: true, value: namespace };
  }
  const record = namespace as Record<string, unknown>;
  return Object.hasOwn(record, PI_MAIL_REMINDER_SETTING)
    ? { defined: true, value: record[PI_MAIL_REMINDER_SETTING] }
    : { defined: false };
}

function decodeScope(
  scope: "project" | "global",
  settings: unknown,
  warnings: ReminderSettingsWarning[],
): ReminderPolicy | undefined {
  const candidate = reminderValue(settings);
  if (!candidate.defined) return undefined;
  try {
    return parseReminderPolicy(candidate.value);
  } catch (error) {
    warnings.push({
      scope,
      message: `Invalid ${scope} ${PI_MAIL_SETTINGS_NAMESPACE}.${PI_MAIL_REMINDER_SETTING}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }
}

export function loadReminderSettings(
  cwd: string,
  projectTrusted: boolean,
  agentDir?: string,
): LoadedReminderSettings {
  const manager = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const warnings: ReminderSettingsWarning[] = manager.drainErrors()
    .filter((entry) => entry.scope === "global" || projectTrusted)
    .map((entry) => ({
      scope: entry.scope,
      message: `Unable to read ${entry.scope} Pi settings: ${entry.error.message}`,
    }));
  const project = projectTrusted
    ? decodeScope("project", manager.getProjectSettings(), warnings)
    : undefined;
  const global = decodeScope("global", manager.getGlobalSettings(), warnings);

  if (project) return { defaultReminder: { policy: project, source: "project" }, warnings };
  if (global) return { defaultReminder: { policy: global, source: "global" }, warnings };
  return { defaultReminder: { policy: { kind: "off" }, source: "built-in" }, warnings };
}
