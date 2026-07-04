/**
 * Reads the guestToken cookie inside a Server Action or Route Handler
 * and returns the resolved guest ID.
 *
 * Returns null when called from a context where the cookie isn't available
 * (e.g. worker-to-server API calls), in which case the caller should skip
 * the guest filter.
 */
import { cookies } from "next/headers";
import { validateGuestToken, createGuest, GUEST_COOKIE_NAME } from "./guestAuth";

export async function getGuestId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(GUEST_COOKIE_NAME)?.value;
    if (!token) return null;

    const guest = await validateGuestToken(token);
    if (!guest) return null;

    return guest.id;
  } catch {
    return null;
  }
}
