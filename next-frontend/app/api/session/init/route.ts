import { NextRequest, NextResponse } from "next/server";
import { readSessionToken } from "@/app/lib/sessionConstants";
import { resolveOrCreateSession } from "@/app/lib/sessionAuth";
import { setSessionCookie } from "@/app/lib/sessionCookie";
import { safeNextPath } from "@/app/lib/safeRedirect";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Called by the proxy when no session cookie is present. Creates (or
 * re-validates) the workspace + anonymous session, sets the httpOnly cookie,
 * and redirects back to the original page.
 */
export async function GET(req: NextRequest) {
  // Only allow same-origin relative paths to prevent an open redirect.
  const safePath = safeNextPath(req.nextUrl.searchParams.get("returnTo"));

  const existingToken = readSessionToken(req.cookies);

  const { token } = await resolveOrCreateSession(
    existingToken,
    req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip"),
    req.headers.get("user-agent"),
  );

  const redirectUrl = new URL(safePath, req.url);
  const res = NextResponse.redirect(redirectUrl);

  setSessionCookie(res, token);

  return res;
}
