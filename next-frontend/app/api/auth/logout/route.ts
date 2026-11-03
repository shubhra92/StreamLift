import { NextRequest, NextResponse } from "next/server";
import { readSessionToken } from "@/app/lib/sessionConstants";
import { revokeSession, validateSessionToken } from "@/app/lib/sessionAuth";
import { clearSessionCookie } from "@/app/lib/sessionCookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout
 *
 * Revokes only this device session. The workspace, its downloads, workers, and
 * paired TVs stay intact; signing in again restores them. Paired TVs keep their
 * own device tokens and remain connected.
 */
export async function POST(req: NextRequest) {
  const token = readSessionToken(req.cookies);

  if (token) {
    try {
      const context = await validateSessionToken(token);
      if (context) {
        await revokeSession(context.session.id);
      }
    } catch (error) {
      // The cookie must be cleared even if revocation fails (for example a
      // transient database error), otherwise the browser stays "signed in".
      console.error("[auth/logout] failed to revoke session", error);
    }
  }

  const res = NextResponse.json(
    { success: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  clearSessionCookie(res);
  return res;
}
