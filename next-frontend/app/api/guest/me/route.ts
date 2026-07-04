import { NextRequest, NextResponse } from "next/server";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";

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

  return NextResponse.json({
    guest: {
      id: guest.id,
      // Show only first 8 chars as a display handle — never expose the token
      shortId: guest.id.slice(0, 8),
      createdAt: guest.createdAt,
      expiresAt: guest.expiresAt,
    },
  });
}
