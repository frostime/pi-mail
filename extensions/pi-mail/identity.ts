export const MIN_ID_FRAGMENT_LENGTH = 6;
export const SESSION_SHORT_ID_LENGTH = 12;
export const MESSAGE_SHORT_ID_LENGTH = 8;

function compactId(id: string): string {
  return id.replaceAll("-", "").toLowerCase();
}

/**
 * Time-ordered session UUIDs can share a long leading prefix when sessions
 * are created close together. Display the random tail instead.
 */
export function shortSessionId(id: string): string {
  const compact = compactId(id);
  return compact.slice(-SESSION_SHORT_ID_LENGTH);
}

export function shortMessageId(id: string): string {
  const compact = compactId(id);
  return compact.slice(0, MESSAGE_SHORT_ID_LENGTH);
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
