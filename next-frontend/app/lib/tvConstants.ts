/**
 * Android TV pairing constants.
 *
 * The code is a short-lived claim ticket, not a password. Codes use an
 * unambiguous alphabet so they are easy to read across a room and type on a
 * phone: no 0/O or 1/I/L confusion.
 */

export const TV_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const TV_CODE_LENGTH = 6;
export const TV_CODE_TTL_MS = 10 * 60 * 1000;
export const TV_POLL_INTERVAL_MS = 2_000;
/** How long after approval the TV may still poll and receive a device token. */
export const TV_APPROVED_TOKEN_WINDOW_MS = 15 * 60 * 1000;
/** A TV is shown online in the web UI if it polled recently. */
export const TV_DEVICE_ONLINE_MS = 60 * 1000;
export const TV_MAX_DEVICES_PER_GUEST = 8;

export function normalizeTvCode(input: string): string {
  return String(input ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, TV_CODE_LENGTH);
}

export function isValidTvCode(code: string): boolean {
  if (code.length !== TV_CODE_LENGTH) return false;
  return [...code].every((char) => TV_CODE_ALPHABET.includes(char));
}

/** `ABC-DEF`, the display form used on both the TV and the web dialog. */
export function formatTvCode(code: string): string {
  const normalized = normalizeTvCode(code);
  if (normalized.length <= 3) return normalized;
  return `${normalized.slice(0, 3)}-${normalized.slice(3)}`;
}
