// ⚠️  This file must NOT be imported by middleware.ts directly —
//     it uses Node.js APIs (crypto, postgres) that are unavailable in the Edge Runtime.
//     Middleware only imports the plain constants from guestConstants.ts.

import crypto from "crypto";
import { db } from "../db";
import { guests } from "../db/schema";
import { eq, and, gt } from "drizzle-orm";
import type { Guest } from "../db/schema";
import { GUEST_COOKIE_MAX_AGE } from "./guestConstants";

export { GUEST_COOKIE_NAME, GUEST_COOKIE_MAX_AGE } from "./guestConstants";
export type { Guest };

/** Generate a cryptographically random token */
export function generateGuestToken(): string {
  return crypto.randomBytes(32).toString("hex"); // 64-char hex string
}

/** Create a new guest record in the DB and return it */
export async function createGuest(
  ipAddress?: string | null,
  userAgent?: string | null
): Promise<Guest> {
  const token = generateGuestToken();
  const expiresAt = new Date(Date.now() + GUEST_COOKIE_MAX_AGE * 1000);

  const [guest] = await db
    .insert(guests)
    .values({ token, ipAddress: ipAddress ?? null, userAgent: userAgent ?? null, expiresAt })
    .returning();

  return guest;
}

/** Validate a token from the cookie. Returns the guest or null. */
export async function validateGuestToken(token: string): Promise<Guest | null> {
  if (!token || token.length !== 64) return null;

  const now = new Date();
  const [guest] = await db
    .select()
    .from(guests)
    .where(
      and(
        eq(guests.token, token),
        eq(guests.isActive, true),
        gt(guests.expiresAt, now)
      )
    )
    .limit(1);

  if (!guest) return null;

  // Touch lastSeenAt without awaiting — fire and forget
  db.update(guests)
    .set({ lastSeenAt: now })
    .where(eq(guests.id, guest.id))
    .execute()
    .catch(() => {});

  return guest;
}

/** Get or create a guest from the raw token string (may be undefined). */
export async function resolveGuest(
  token: string | undefined,
  ipAddress?: string | null,
  userAgent?: string | null
): Promise<{ guest: Guest; isNew: boolean }> {
  if (token) {
    const existing = await validateGuestToken(token);
    if (existing) return { guest: existing, isNew: false };
  }
  const guest = await createGuest(ipAddress, userAgent);
  return { guest, isNew: true };
}
