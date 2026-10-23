import { NextRequest, NextResponse } from "next/server";
import { pollPairing } from "@/app/lib/tvPairing";
import { checkRateLimit } from "@/app/lib/tvRateLimit";
import { tvHash } from "@/app/lib/tvCrypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/tv/pair/poll
 *
 * The TV polls this with X-Device-Secret. It never sends the 6-character code,
 * so the code cannot be enumerated from this endpoint.
 */
export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-device-secret")?.trim() ?? "";

  const limit = checkRateLimit(`tv-poll:${tvHash(secret).slice(0, 24)}`, 180, 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { success: false, status: "pending", message: "Slow down" },
      { status: 429, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!secret) {
    return NextResponse.json(
      { success: false, status: "unknown", message: "Missing device secret" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const pairing = await pollPairing(secret);

  if (pairing.status === "unknown") {
    return NextResponse.json(
      { success: false, status: "unknown", message: "Pairing not found. Start again." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      success: pairing.status === "approved",
      status: pairing.status,
      expiresAt: pairing.expiresAt?.toISOString(),
      deviceToken: pairing.deviceToken,
      device: pairing.device,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
