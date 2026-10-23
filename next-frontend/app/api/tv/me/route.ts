import { NextRequest, NextResponse } from "next/server";
import { requireTvDevice } from "@/app/lib/tvAuth";
import { revokeTvDevice, toDeviceSummary } from "@/app/lib/tvPairing";
import { clearTvCatalogCache } from "@/app/lib/tvCatalog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/tv/me — validates the TV bearer token on app launch. */
export async function GET(req: NextRequest) {
  const auth = await requireTvDevice(req);
  if (!auth.ok) return auth.response;

  return NextResponse.json(
    {
      success: true,
      device: toDeviceSummary(auth.device),
      guest: { expiresAt: auth.guest.expiresAt.toISOString() },
      serverTime: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** DELETE /api/tv/me — a TV disconnecting itself from its Settings screen. */
export async function DELETE(req: NextRequest) {
  const auth = await requireTvDevice(req);
  if (!auth.ok) return auth.response;

  await revokeTvDevice(auth.guest.id, auth.device.id);
  clearTvCatalogCache(auth.guest.id);

  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
