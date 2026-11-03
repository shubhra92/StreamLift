/**
 * Plain constants and cookie helpers — no Node.js imports.
 * Safe to import from both Edge Runtime (proxy.ts) and Node.js.
 *
 * `sl_session` is the canonical cookie. `guestToken` is read (and, for one
 * release, written) as a compatibility fallback so tabs opened before the
 * workspace migration keep working.
 */

export const SESSION_COOKIE_NAME = "sl_session";
export const LEGACY_SESSION_COOKIE_NAME = "guestToken";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days in seconds

export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/** Read the canonical session cookie, falling back to the legacy name. */
export function readSessionToken(cookies: CookieReader): string | null {
  return (
    cookies.get(SESSION_COOKIE_NAME)?.value ??
    cookies.get(LEGACY_SESSION_COOKIE_NAME)?.value ??
    null
  );
}
