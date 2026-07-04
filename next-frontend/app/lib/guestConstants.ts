/**
 * Plain constants — no Node.js imports.
 * Safe to import from both Edge Runtime (middleware) and Node.js.
 */
export const GUEST_COOKIE_NAME = "guestToken";
export const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days in seconds
