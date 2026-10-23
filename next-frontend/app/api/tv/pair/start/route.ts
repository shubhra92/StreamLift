import { NextRequest, NextResponse } from "next/server";
import { startPairing, TvPairingError, isValidDeviceSecret } from "@/app/lib/tvPairing";
import { checkRateLimit, requestIp } from "@/app/lib/tvRateLimit";
import { tvHash } from "@/app/lib/tvCrypto";
import { TV_CODE_TTL_MS, TV_POLL_INTERVAL_MS } from "@/app/lib/tvConstants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/tv/pair/start
 *
 * Called by an unpaired TV. The TV generates a device secret locally and sends
 * only a hash-relevant device description here. The server returns a short
 * code for the user to enter in the web watch page.
 */
export async function POST(req: NextRequest) {
  const ip = requestIp(req.headers);
  const limit = checkRateLimit(`tv-start:${ip}`, 20, 60 * 60 * 1000);
  if (!limit.ok) {
    return NextResponse.json(
      { success: false, error: "rate_limited", message: "Too many pairing attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { success: false, error: "invalid_json", message: "Invalid request body" },
      { status: 400 },
    );
  }

  if (!isValidDeviceSecret(body.deviceSecret)) {
    return NextResponse.json(
      { success: false, error: "invalid_secret", message: "Invalid device secret" },
      { status: 400 },
    );
  }

  try {
    const pairing = await startPairing({
      deviceSecret: body.deviceSecret,
      deviceName: typeof body.deviceName === "string" ? body.deviceName : null,
      model: typeof body.model === "string" ? body.model : null,
      appVersion: typeof body.appVersion === "string" ? body.appVersion : null,
      ipHash: tvHash(ip),
    });

    return NextResponse.json(
      {
        success: true,
        code: pairing.code,
        expiresAt: pairing.expiresAt.toISOString(),
        expiresInMs: TV_CODE_TTL_MS,
        pollIntervalMs: TV_POLL_INTERVAL_MS,
        serverTime: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof TvPairingError) {
      return NextResponse.json(
        { success: false, error: "pairing_error", message: error.message },
        { status: error.status },
      );
    }
    console.error("TV pair start failed:", error);
    return NextResponse.json(
      { success: false, error: "server_error", message: "Could not start pairing" },
      { status: 500 },
    );
  }
}
