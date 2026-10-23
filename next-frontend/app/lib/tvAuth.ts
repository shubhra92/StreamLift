import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { guests, tvDevices } from "../db/schema";
import type { Guest, TvDevice } from "../db/schema";
import { GUEST_COOKIE_MAX_AGE, GUEST_COOKIE_NAME } from "./guestConstants";
import { validateGuestToken } from "./guestAuth";
import { tvHash } from "./tvCrypto";
import { consumeApprovedPairings } from "./tvPairing";

export type TvAuthResult =
  | { ok: true; device: TvDevice; guest: Guest }
  | { ok: false; response: NextResponse };

export type WebGuestResult =
  | { ok: true; guest: Guest }
  | { ok: false; response: NextResponse };

function jsonError(message: string, status: number, code: string): NextResponse {
  return NextResponse.json(
    { success: false, error: code, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/**
 * Authenticate a TV request with its device bearer token.
 *
 * The guest expiry is slid forward on every authenticated TV request. Without
 * this, a paired TV would silently stop working when the 30-day browser guest
 * expires. The web cookie is refreshed separately by the middleware.
 */
export async function requireTvDevice(req: NextRequest): Promise<TvAuthResult> {
  const token = bearerToken(req);
  if (!token) return { ok: false, response: jsonError("Unauthorized", 401, "unauthorized") };

  const [device] = await db
    .select()
    .from(tvDevices)
    .where(and(eq(tvDevices.tokenHash, tvHash(token)), isNull(tvDevices.revokedAt)))
    .limit(1);

  if (!device) {
    return { ok: false, response: jsonError("This TV is no longer connected.", 401, "device_revoked") };
  }

  const [guest] = await db.select().from(guests).where(eq(guests.id, device.guestId)).limit(1);

  if (!guest || !guest.isActive) {
    return { ok: false, response: jsonError("This StreamLift session is no longer active.", 401, "guest_inactive") };
  }

  const now = new Date();
  if (guest.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, response: jsonError("This StreamLift session has expired. Pair the TV again.", 401, "guest_expired") };
  }

  const nextGuestExpiry = new Date(now.getTime() + GUEST_COOKIE_MAX_AGE * 1000);
  await Promise.all([
    db
      .update(guests)
      .set({ expiresAt: nextGuestExpiry, lastSeenAt: now })
      .where(eq(guests.id, guest.id)),
    db
      .update(tvDevices)
      .set({ lastSeenAt: now })
      .where(eq(tvDevices.id, device.id)),
  ]);

  // The TV has used its bearer token; stop issuing pairing tokens.
  await consumeApprovedPairings(device.id).catch(() => {});

  return {
    ok: true,
    device: { ...device, lastSeenAt: now },
    guest: { ...guest, expiresAt: nextGuestExpiry, lastSeenAt: now },
  };
}

/** Authenticate a web request using the normal guestToken cookie. */
export async function requireWebGuest(req: NextRequest): Promise<WebGuestResult> {
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
  if (!token) return { ok: false, response: jsonError("Unauthorized", 401, "unauthorized") };

  const guest = await validateGuestToken(token);
  if (!guest) {
    return { ok: false, response: jsonError("Unauthorized", 401, "unauthorized") };
  }

  return { ok: true, guest };
}

export function unauthorizedResponse(message = "Unauthorized", code = "unauthorized"): NextResponse {
  return jsonError(message, 401, code);
}
