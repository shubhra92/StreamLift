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
let verifiedGuestId: string | null = null;
let guestRequest: Promise<CurrentGuest | null> | null = null;
let guardRequest: Promise<string | null> | null = null;

export interface CurrentGuest {
  id: string;
  shortId: string | null;
}

/**
 * Fetch the current guest id from the Next.js /api/guest/me route.
 * Returns null if unauthenticated or the request fails.
 */
export function getCurrentGuest(): Promise<CurrentGuest | null> {
  if (!guestRequest) {
    guestRequest = fetch("/api/guest/me", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return null;
        const guest = (await res.json())?.guest;
        return guest?.id ? { id: guest.id as string, shortId: guest.shortId ?? null } : null;
      })
      .catch(() => null);
  }
  return guestRequest;
}

/**
 * Run the guest guard check. Safe to call multiple times — only runs once
 * per page lifetime (tracked via the `checked` flag).
 *
 * Returns the current guestId (or null if unauthenticated).
 */
export async function runGuestGuard(): Promise<string | null> {
  if (guardRequest) return guardRequest;
  if (checked) return verifiedGuestId;

  guardRequest = (async () => {
    const guest = await getCurrentGuest();
    if (!guest) return null;
    const currentGuestId = guest.id;

    const cachedGuestId = await getCursor("guest_id");

    if (cachedGuestId && cachedGuestId !== currentGuestId) {
      console.info("[IDB] Guest rotation detected — clearing cache");
      await clearAllIDB();
    }

    await setCursor("guest_id", currentGuestId);
    verifiedGuestId = currentGuestId;
    checked = true;
    return currentGuestId;
  })();

  return guardRequest;
}

/** Reset the guard flag (for testing or explicit re-initialisation). */
export function resetGuestGuard(): void {
  checked = false;
  verifiedGuestId = null;
  guestRequest = null;
  guardRequest = null;
}
