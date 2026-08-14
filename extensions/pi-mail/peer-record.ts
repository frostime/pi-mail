import type { PeerRecord as PeerRecordV1 } from "./types.ts";

export type StoredReminderOverride = "off" | "after-turn" | number;

/** Current peer schema. An absent reminder means inherit the runtime default. */
export interface PeerRecordV2 extends Omit<PeerRecordV1, "version" | "reminderAfterMinutes"> {
  version: 2;
  reminder?: StoredReminderOverride;
}

export type StoredPeerRecord = PeerRecordV1 | PeerRecordV2;

/**
 * Decode and validate one stored peer into the current schema.
 *
 * Legacy mapping:
 * - reminderAfterMinutes 1–1440 -> matching minute override
 * - absent, null, or 0 -> explicit off
 * - malformed values and unknown versions -> identifying error
 *
 * mail-attention-policy::shape — all peer-version compatibility belongs here;
 * downstream modules consume PeerRecordV2 only.
 */
export function decodePeerRecord(_value: unknown, _source: string): PeerRecordV2 {
  throw new Error("mail-attention-policy peer decoding is not implemented");
}
