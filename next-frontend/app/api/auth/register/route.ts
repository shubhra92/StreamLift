import { NextRequest, NextResponse } from "next/server";
import { readSessionToken } from "@/app/lib/sessionConstants";
import {
  resolveOrCreateSession,
  revokeSession,
} from "@/app/lib/sessionAuth";
import { setSessionCookie } from "@/app/lib/sessionCookie";
import { checkRateLimit, requestIp } from "@/app/lib/tvRateLimit";
import {
  getAccountForWorkspace,
  isValidEmail,
  isValidPassword,
  normalizeEmail,
  registerWorkspaceAccount,
} from "@/app/lib/accountAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, status: number, code: string): NextResponse {
  return NextResponse.json(
    { success: false, error: code, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * POST /api/auth/register
 *
 * Converts the current anonymous workspace into a permanent account. The
 * workspace id stays the same, so every worker, download, TV pairing, and
 * storage folder continues to belong to the same workspace.
 *
 * The new authenticated session is created before the old anonymous session is
 * revoked, so the browser never loses access during the upgrade.
 */
export async function POST(req: NextRequest) {
  const ip = requestIp(req.headers);
  const limit = checkRateLimit(`account-register:${ip}`, 5, 60 * 60 * 1000);
  if (!limit.ok) {
    const res = jsonError(
      "Too many attempts. Please try again later.",
      429,
      "rate_limited",
    );
    res.headers.set("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
    return res;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid request.", 400, "invalid_json");
  }

  const payload = (body ?? {}) as { email?: unknown; password?: unknown };
  const rawEmail = typeof payload.email === "string" ? payload.email : "";
  const password = typeof payload.password === "string" ? payload.password : "";
  const email = normalizeEmail(rawEmail);

  if (!isValidEmail(email)) {
    return jsonError("Enter a valid email address.", 400, "invalid_email");
  }
  if (!isValidPassword(password)) {
    return jsonError(
      "Password must be between 8 and 128 characters.",
      400,
      "invalid_password",
    );
  }

  // No session cookie yet (for example, a direct visit to /register): create a
  // workspace now so the account has something to own.
  const currentToken = readSessionToken(req.cookies);
  const { context, token } = await resolveOrCreateSession(
    currentToken,
    ip,
    req.headers.get("user-agent"),
  );

  const existing = await getAccountForWorkspace(context.workspace.id);
  if (existing || context.workspace.ownerUserId) {
    const res = jsonError(
      "This session already has an account. Sign in instead.",
      409,
      "already_registered",
    );
    setSessionCookie(res, token);
    return res;
  }

  const result = await registerWorkspaceAccount(
    context.workspace.id,
    email,
    password,
    ip,
    req.headers.get("user-agent"),
  );
  if (!result.ok) {
    const status =
      result.code === "workspace_missing"
        ? 400
        : 409;
    const res = jsonError(result.message, status, result.code);
    setSessionCookie(res, token);
    return res;
  }

  const res = NextResponse.json(
    {
      success: true,
      guest: {
        id: result.workspace.id,
        shortId: result.workspace.id.slice(0, 8),
        isRegistered: true,
      },
      workspace: {
        id: result.workspace.id,
        name: result.workspace.name,
        isRegistered: true,
      },
      account: {
        email: result.account.email,
        createdAt: result.account.createdAt,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
  setSessionCookie(res, result.token);

  // The old anonymous device session is no longer needed. The new session was
  // created in the same transaction as the workspace claim.
  await revokeSession(context.session.id);

  return res;
}
