import { NextRequest, NextResponse } from "next/server";
import { GUEST_COOKIE_NAME } from "./app/lib/guestConstants";

export const config = {
  matcher: [
    // Only run on page routes — skip all API routes, static assets, Next internals
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

/**
 * Edge middleware — intentionally zero Node.js imports.
 * All it does is check if the guestToken cookie exists.
 * If missing, it rewrites to the guest-init API route which runs in Node.js,
 * creates the guest, sets the cookie, then redirects back to the original URL.
 */
export function proxy(req: NextRequest) {
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;

  // Cookie present — nothing to do, let the request through
  if (token) {
    return NextResponse.next();
  }

  // No cookie — bounce through the init route so Node.js can create the guest
  const returnTo = req.nextUrl.pathname + req.nextUrl.search;
  const initUrl = new URL("/api/guest/init", req.url);
  initUrl.searchParams.set("returnTo", returnTo);

  return NextResponse.redirect(initUrl);
}
