import { NextRequest, NextResponse } from "next/server";
import { readSessionToken } from "@/app/lib/sessionConstants";
import { validateSessionToken } from "@/app/lib/sessionAuth";
import { clearSessionCookie, setSessionCookie } from "@/app/lib/sessionCookie";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/session/me
 *
 * Returns the current workspace/session/account. The legacy `guest` object is
 * kept for one release because the Android TV app reads `guest.expiresAt`.
 */
export async function GET(req: NextRequest) {
  const token = readSessionToken(req.cookies);
  if (!token) {
    return NextResponse.json(
      { guest: null, workspace: null, account: null },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const context = await validateSessionToken(token);
  if (!context) {
    // Drop the dead cookie so the next navigation can bootstrap a fresh
    // anonymous workspace instead of getting stuck on a stale token.
    const res = NextResponse.json(
      { guest: null, workspace: null, account: null },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
    clearSessionCookie(res);
    return res;
  }

  const { workspace, user } = context;
  const isRegistered = Boolean(workspace.ownerUserId && user);
  const account = user
    ? { email: user.email, createdAt: user.createdAt }
    : null;

  const res = NextResponse.json({
    guest: {
      id: workspace.id,
      // Show only first 8 chars as a display handle — never expose the token
      shortId: workspace.id.slice(0, 8),
      createdAt: workspace.createdAt,
      expiresAt: workspace.expiresAt,
      isRegistered,
    },
    workspace: {
      id: workspace.id,
      name: workspace.name,
      expiresAt: workspace.expiresAt,
      isRegistered,
    },
    account,
  });

  setSessionCookie(res, token);

  return res;
}
