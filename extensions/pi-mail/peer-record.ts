import { MAX_REMINDER_MINUTES, MIN_REMINDER_MINUTES, parseReminderPolicy } from "./attention-policy.ts";
import type { LegacyPeerRecord } from "./types.ts";

export type StoredReminderOverride = "off" | "after-turn" | number;

export interface PeerRecordV2 extends Omit<LegacyPeerRecord, "version" | "reminderAfterMinutes"> {
  version: 2;
  reminder?: StoredReminderOverride;
  /** New, unused mailboxes remain temporary until they gain durable value. */
  provisional?: true;
}

export type StoredPeerRecord = LegacyPeerRecord | PeerRecordV2;

function asRecord(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid peer record at ${source}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function validateIdentity(record: Record<string, unknown>, source: string): void {
  for (const field of ["id", "alias", "cwd", "createdAt", "updatedAt"] as const) {
    if (typeof record[field] !== "string") {
      throw new Error(`Invalid peer record at ${source}: ${field} must be a string`);
    }
  }
  if (typeof record.discoverable !== "boolean") {
    throw new Error(`Invalid peer record at ${source}: discoverable must be a boolean`);
  }
}

function decodeCurrent(record: Record<string, unknown>, source: string): PeerRecordV2 {
  if (Object.hasOwn(record, "reminderAfterMinutes")) {
    throw new Error(`Invalid peer record at ${source}: version 2 must not contain legacy reminderAfterMinutes`);
  }
  if (Object.hasOwn(record, "provisional") && record.provisional !== true) {
    throw new Error(`Invalid peer record at ${source}: provisional must be true when present`);
  }
  if (Object.hasOwn(record, "reminder")) {
    try {
      parseReminderPolicy(record.reminder);
    } catch (error) {
      throw new Error(`Invalid peer record at ${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return record as unknown as PeerRecordV2;
}

function decodeLegacy(record: Record<string, unknown>, source: string): PeerRecordV2 {
  const legacy = record as unknown as LegacyPeerRecord;
  const value = record.reminderAfterMinutes;
  let reminder: StoredReminderOverride = "off";
  if (value !== undefined && value !== null && value !== 0) {
    if (typeof value !== "number" || !Number.isInteger(value)
      || value < MIN_REMINDER_MINUTES || value > MAX_REMINDER_MINUTES) {
      throw new Error(`Invalid peer record at ${source}: legacy reminderAfterMinutes must be 0 or an integer from ${MIN_REMINDER_MINUTES} through ${MAX_REMINDER_MINUTES}`);
    }
    reminder = value;
  }

  const { reminderAfterMinutes: _legacyReminder, version: _legacyVersion, ...identity } = legacy;
  return { ...identity, version: 2, reminder };
}

export function decodePeerRecord(value: unknown, source: string): PeerRecordV2 {
  const record = asRecord(value, source);
  validateIdentity(record, source);
  if (record.version === 1) return decodeLegacy(record, source);
  if (record.version === 2) return decodeCurrent(record, source);
  throw new Error(`Invalid peer record at ${source}: unsupported version ${String(record.version)}`);
}
