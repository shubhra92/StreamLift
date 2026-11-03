import { NextRequest, NextResponse } from "next/server";
import { requireWebSession } from "@/app/lib/tvAuth";
import { listTvDevices } from "@/app/lib/tvPairing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/tv/devices — TVs paired to the current web workspace session. */
export async function GET(req: NextRequest) {
  const auth = await requireWebSession(req);
  if (!auth.ok) return auth.response;

  const devices = await listTvDevices(auth.context.workspace.id);
  return NextResponse.json(
    { success: true, devices },
    { headers: { "Cache-Control": "no-store" } },
  );
}
