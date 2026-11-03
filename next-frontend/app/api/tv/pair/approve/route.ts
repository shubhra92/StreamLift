import { NextRequest, NextResponse } from "next/server";
import { requireWebSession } from "@/app/lib/tvAuth";
import { approvePairing } from "@/app/lib/tvPairing";
import { checkRateLimit, requestIp } from "@/app/lib/tvRateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/tv/pair/approve  { code: "ABC-DEF" }
 *
 * A web session approves a code shown on the TV. The TV's next poll receives
 * its own long-lived device token; the browser cookie is never shared.
 */
export async function POST(req: NextRequest) {
  const auth = await requireWebSession(req);
  if (!auth.ok) return auth.response;

  const ip = requestIp(req.headers);
  const ipLimit = checkRateLimit(`tv-approve-ip:${ip}`, 10, 10 * 60 * 1000);
  if (!ipLimit.ok) {
    return NextResponse.json(
      { success: false, error: "rate_limited", message: "Too many attempts. Wait a few minutes." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(ipLimit.retryAfterMs / 1000)) } },
    );
  }

  const workspaceLimit = checkRateLimit(`tv-approve-workspace:${auth.context.workspace.id}`, 20, 60 * 60 * 1000);
  if (!workspaceLimit.ok) {
    return NextResponse.json(
      { success: false, error: "rate_limited", message: "Too many attempts for this session." },
      { status: 429 },
    );
  }

  let body: { code?: unknown };
  try {
    body = (await req.json()) as { code?: unknown };
  } catch {
    return NextResponse.json(
      { success: false, error: "invalid_json", message: "Invalid request body" },
      { status: 400 },
    );
  }

  const result = await approvePairing(typeof body.code === "string" ? body.code : "", auth.context.workspace.id);

  if ("error" in result) {
    return NextResponse.json(
      { success: false, error: "pairing_failed", message: result.error },
      { status: result.status },
    );
  }

  return NextResponse.json(
    {
      success: true,
      device: {
        id: result.device.id,
        name: result.device.name,
        model: result.device.model,
        appVersion: result.device.appVersion,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
