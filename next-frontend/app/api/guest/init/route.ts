import { NextRequest, NextResponse } from "next/server";
import { resolveGuest, GUEST_COOKIE_NAME, GUEST_COOKIE_MAX_AGE } from "@/app/lib/guestAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Called by middleware when no guestToken cookie is present.
 * Creates (or re-validates) the guest, sets the httpOnly cookie,
 * and redirects back to the original page.
 */
export async function GET(req: NextRequest) {
  const returnTo = req.nextUrl.searchParams.get("returnTo") || "/";

  // Sanitise returnTo — only allow relative paths to prevent open-redirect
  const safePath = returnTo.startsWith("/") ? returnTo : "/";

  const existingToken = req.cookies.get(GUEST_COOKIE_NAME)?.value;

  const { guest } = await resolveGuest(
    existingToken,
    req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip"),
    req.headers.get("user-agent")
  );

  const redirectUrl = new URL(safePath, req.url);
  const res = NextResponse.redirect(redirectUrl);

  res.cookies.set(GUEST_COOKIE_NAME, guest.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: GUEST_COOKIE_MAX_AGE,
    path: "/",
  });

  return res;
}
