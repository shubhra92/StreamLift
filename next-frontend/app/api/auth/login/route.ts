import { NextRequest, NextResponse } from "next/server";
import { readSessionToken } from "@/app/lib/sessionConstants";
import {
  createUserSession,
  revokeSession,
  validateSessionToken,
} from "@/app/lib/sessionAuth";
import { setSessionCookie } from "@/app/lib/sessionCookie";
import { checkRateLimit, requestIp } from "@/app/lib/tvRateLimit";
import {
  authenticateAccount,
  isValidEmail,
  normalizeEmail,
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
 * POST /api/auth/login
 *
 * Signs into the workspace owned by the account and creates a fresh
 * per-device session. Any previous session in this browser is revoked after
 * the new cookie is ready.
 */
export async function POST(req: NextRequest) {
  const ip = requestIp(req.headers);

  // Coarse per-IP limit first, then a stricter per-IP+email bucket.
  const ipLimit = checkRateLimit(`account-login:ip:${ip}`, 30, 60 * 60 * 1000);
  if (!ipLimit.ok) {
    const res = jsonError(
      "Too many attempts. Please try again later.",
      429,
      "rate_limited",
    );
    res.headers.set("Retry-After", String(Math.ceil(ipLimit.retryAfterMs / 1000)));
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

  if (!isValidEmail(email) || !password) {
    return jsonError("Enter your email and password.", 400, "invalid_input");
  }

  const attemptLimit = checkRateLimit(
    `account-login:${ip}:${email}`,
    10,
    15 * 60 * 1000,
  );
  if (!attemptLimit.ok) {
    const res = jsonError(
      "Too many attempts. Please try again later.",
      429,
      "rate_limited",
    );
    res.headers.set(
      "Retry-After",
      String(Math.ceil(attemptLimit.retryAfterMs / 1000)),
    );
    return res;
  }

  const result = await authenticateAccount(email, password);
  if (!result.ok) {
    return jsonError(
      result.message,
      result.code === "inactive" ? 403 : 401,
      result.code,
    );
  }

  // Remember which device session this browser had, but do not revoke it until
  // the new cookie has been prepared.
  const previousToken = readSessionToken(req.cookies);
  const previous = previousToken
    ? await validateSessionToken(previousToken)
    : null;

  const authenticated = await createUserSession(
    result.workspace,
    result.user,
    ip,
    req.headers.get("user-agent"),
  );

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
      account: { email: result.user.email },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
  setSessionCookie(res, authenticated.token);

  if (previous) {
    await revokeSession(previous.session.id);
  }

  return res;
}
