import { randomInt } from "node:crypto";

export const MIN_ID_FRAGMENT_LENGTH = 6;
export const SESSION_SHORT_ID_LENGTH = 12;
export const LEGACY_MESSAGE_SHORT_ID_LENGTH = 8;
export const MESSAGE_ID_LENGTH = 7;

const MESSAGE_ID_SPACE = 36 ** MESSAGE_ID_LENGTH;
const COMPACT_MESSAGE_ID = /^[0-9a-z]{7}$/;
const UUID_MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function compactId(id: string): string {
  return id.replaceAll("-", "").toLowerCase();
}

export function generateMessageId(): string {
  return randomInt(MESSAGE_ID_SPACE).toString(36).padStart(MESSAGE_ID_LENGTH, "0");
}

export function isCompactMessageId(id: string): boolean {
  return COMPACT_MESSAGE_ID.test(id);
}

export function isLegacyUuidMessageId(id: string): boolean {
  return UUID_MESSAGE_ID.test(id);
}

/**
 * Time-ordered session UUIDs can share a long leading prefix when sessions
 * are created close together. Display the random tail instead.
 */
export function shortSessionId(id: string): string {
  const compact = compactId(id);
  return compact.slice(-SESSION_SHORT_ID_LENGTH);
}

export function legacyMessageRef(id: string): string {
  return compactId(id).slice(0, LEGACY_MESSAGE_SHORT_ID_LENGTH);
}

export function shortMessageId(id: string): string {
  if (isCompactMessageId(id) || !isLegacyUuidMessageId(id)) return id;
  // Legacy UUID records are shown in full. The short form remains accepted
  // only by the compatibility resolver for messages written by old versions.
  return id;
}

/**
 * Accept both leading and trailing fragments. Leading fragments preserve the
 * addressing behavior from earlier Pi Mail releases; trailing fragments make
 * the displayed session short ID directly usable as an address.
 */
export function matchesIdFragment(id: string, fragment: string): boolean {
  const query = compactId(fragment.trim());
  if (query.length < MIN_ID_FRAGMENT_LENGTH) return false;

  const compact = compactId(id);
  return compact.startsWith(query) || compact.endsWith(query);
}
