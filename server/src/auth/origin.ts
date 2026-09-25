// Origin check for state-changing admin requests, pure. Browsers attach `Origin` to every
// cross-origin request and to same-origin POST/DELETE; a request without one is a non-browser
// client or a same-origin GET.

export type OriginCheck = 'ok' | 'missing' | 'invalid';

/**
 * `ok` when the header is present, a single well-formed origin, and listed in `allowed`.
 * `missing` when absent or empty. `invalid` for `null`, several values, a malformed value, or a
 * foreign origin. Matching compares normalized origins, so a trailing slash or upper-case host still matches.
 */
export function checkOrigin(header: string | string[] | undefined, allowed: ReadonlyArray<string>): OriginCheck {
  if (header === undefined) return 'missing';
  if (Array.isArray(header)) {
    if (header.length === 0) return 'missing';
    if (header.length > 1) return 'invalid';
    header = header[0] as string;
  }
  const value = header.trim();
  if (value.length === 0) return 'missing';
  if (value.includes(',') || value.includes(' ')) return 'invalid';
  let origin: string;
  try {
    const url = new URL(value);
    // An origin has no path, query, or fragment; `new URL` tolerates them, the check does not.
    if (url.origin === 'null' || url.pathname !== '/' || url.search || url.hash) return 'invalid';
    origin = url.origin;
  } catch {
    return 'invalid';
  }
  return allowed.includes(origin) ? 'ok' : 'invalid';
}
