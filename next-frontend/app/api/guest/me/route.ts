import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/app/db";
import { guests } from "@/app/db/schema";
import {
  validateGuestToken,
  GUEST_COOKIE_NAME,
  GUEST_COOKIE_MAX_AGE,
} from "@/app/lib/guestAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ guest: null }, { status: 401 });
  }

  const guest = await validateGuestToken(token);
  if (!guest) {
    return NextResponse.json({ guest: null }, { status: 401 });
  }

  // Sliding session: an active web session keeps both the browser cookie and
  // the DB guest alive. This also keeps a paired TV working, because the TV's
  // device token is bound to this guest.
  const expiresAt = new Date(Date.now() + GUEST_COOKIE_MAX_AGE * 1000);
  await db
    .update(guests)
    .set({ expiresAt, lastSeenAt: new Date() })
    .where(eq(guests.id, guest.id));

  const res = NextResponse.json({
    guest: {
      id: guest.id,
      // Show only first 8 chars as a display handle — never expose the token
      shortId: guest.id.slice(0, 8),
      createdAt: guest.createdAt,
      expiresAt,
    },
  });

  res.cookies.set(GUEST_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: GUEST_COOKIE_MAX_AGE,
    path: "/",
  });

  return res;
}
