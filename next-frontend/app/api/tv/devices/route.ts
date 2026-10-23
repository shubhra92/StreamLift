import { NextRequest, NextResponse } from "next/server";
import { requireWebGuest } from "@/app/lib/tvAuth";
import { listTvDevices } from "@/app/lib/tvPairing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/tv/devices — TVs paired to the current web guest session. */
export async function GET(req: NextRequest) {
  const auth = await requireWebGuest(req);
  if (!auth.ok) return auth.response;

  const devices = await listTvDevices(auth.guest.id);
  return NextResponse.json(
    { success: true, devices },
    { headers: { "Cache-Control": "no-store" } },
  );
}
