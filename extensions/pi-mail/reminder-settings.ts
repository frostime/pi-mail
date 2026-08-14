import type { ReminderPolicy } from "./attention-policy.ts";

export const PI_MAIL_SETTINGS_NAMESPACE = "ext::pi-mail";
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

/**
 * Read namespace `ext::pi-mail`, field `reminder`, through Pi SettingsManager.
 * Project settings use the active ctx.cwd and are omitted when untrusted.
 *
 * mail-attention-policy::shape — this boundary is read-only and returns
 * warnings to the entry adapter; it never calls UI methods or writes settings.
 */
export function loadReminderSettings(
  _cwd: string,
  _projectTrusted: boolean,
  _agentDir?: string,
): LoadedReminderSettings {
  throw new Error("mail-attention-policy reminder settings are not implemented");
}
