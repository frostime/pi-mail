const COMPACT_ID_CHARS = 12;
const MIN_REFERENCE_CHARS = 6;

function normalizedId(value: string): string {
  return value.replaceAll("-", "").toLowerCase();
}

/**
 * UUIDv7 prefixes encode time and therefore collide visually for sessions
 * created close together. Use the random tail for a stable display handle.
 */
export function shortId(id: string): string {
  const compact = normalizedId(id);
  if (compact.length <= COMPACT_ID_CHARS) return compact;
  return compact.slice(-COMPACT_ID_CHARS);
}

export function minimumReferenceChars(): number {
  return MIN_REFERENCE_CHARS;
}

/**
 * Preserve historical prefix references while also accepting the displayed
 * suffix-based short ID introduced after UUIDv7 prefix collisions surfaced.
 */
export function idMatchesReference(id: string, reference: string): boolean {
  const query = reference.trim().toLowerCase();
  if (!query) return false;
  if (id.toLowerCase() === query) return true;
  if (id.toLowerCase().startsWith(query)) return true;

  const compactId = normalizedId(id);
  const compactQuery = normalizedId(query);
  if (compactQuery.length < MIN_REFERENCE_CHARS) return false;

  return compactId.startsWith(compactQuery) || compactId.endsWith(compactQuery);
}
