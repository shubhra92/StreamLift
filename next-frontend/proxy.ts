import { NextRequest, NextResponse } from "next/server";
import { readSessionToken } from "./app/lib/sessionConstants";

export const config = {
  matcher: [
    // Only run on page routes — skip all API routes, static assets, Next internals
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

// Auth pages must not bootstrap a guest session: otherwise signing out would
// immediately create a fresh guest and trap the user away from the login form.
const PUBLIC_AUTH_ROUTES = new Set(["/login", "/register"]);

/**
 * Edge middleware — intentionally zero Node.js imports.
 * It only checks whether a session cookie exists. If missing, it rewrites to
 * the session-init API route which runs in Node.js, creates the workspace and
 * session, sets the cookie, then redirects back to the original URL.
 *
 * `readSessionToken` accepts both `sl_session` and the legacy `guestToken`
 * cookie for one release.
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Login/register render without a session. The auth route handlers create a
  // workspace only when registration actually needs one.
  if (PUBLIC_AUTH_ROUTES.has(pathname)) {
    return NextResponse.next();
  }

  const token = readSessionToken(req.cookies);

  // Cookie present — nothing to do, let the request through
  if (token) {
    return NextResponse.next();
  }

  // No cookie — bounce through the init route so Node.js can create the session
  const returnTo = req.nextUrl.pathname + req.nextUrl.search;
  const initUrl = new URL("/api/session/init", req.url);
  initUrl.searchParams.set("returnTo", returnTo);

  return NextResponse.redirect(initUrl);
}
