/**
 * Guest Guard
 *
 * Compares the guestId stored in IDB against the current session guestId.
 * If they differ (guest rotation, cookie reset) the entire IDB cache is
 * cleared so we never show another guest's data.
 *
 * Call once at app initialisation (e.g. in a top-level client component or
 * the SyncManager init path).
 */

import { getCursor, setCursor, clearAllIDB } from "./IDBStore";

let checked = false;

/**
 * Fetch the current guest id from the Next.js /api/guest/me route.
 * Returns null if unauthenticated or the request fails.
 */
async function fetchCurrentGuestId(): Promise<string | null> {
  try {
    const res = await fetch("/api/guest/me", { credentials: "include" });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.guest?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Run the guest guard check. Safe to call multiple times — only runs once
 * per page lifetime (tracked via the `checked` flag).
 *
 * Returns the current guestId (or null if unauthenticated).
 */
export async function runGuestGuard(): Promise<string | null> {
  if (checked) return null;
  checked = true;

  const currentGuestId = await fetchCurrentGuestId();
  if (!currentGuestId) return null;

  const cachedGuestId = await getCursor("guest_id");

  if (cachedGuestId && cachedGuestId !== currentGuestId) {
    // Guest has rotated — wipe everything
    console.info("[IDB] Guest rotation detected — clearing cache");
    await clearAllIDB();
  }

  // Always persist the current guest id
  await setCursor("guest_id", currentGuestId);

  return currentGuestId;
}

/** Reset the guard flag (for testing or explicit re-initialisation). */
export function resetGuestGuard(): void {
  checked = false;
}
