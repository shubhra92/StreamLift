import { NextRequest, NextResponse } from "next/server";
import { requireWebGuest } from "@/app/lib/tvAuth";
import { revokeTvDevice } from "@/app/lib/tvPairing";
import { clearTvCatalogCache } from "@/app/lib/tvCatalog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** DELETE /api/tv/devices/[deviceId] — revoke a TV immediately. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const auth = await requireWebGuest(req);
  if (!auth.ok) return auth.response;

  const { deviceId } = await params;
  const revoked = await revokeTvDevice(auth.guest.id, deviceId);

  if (!revoked) {
    return NextResponse.json(
      { success: false, error: "not_found", message: "TV not found" },
      { status: 404 },
    );
  }

  clearTvCatalogCache(auth.guest.id);
  return NextResponse.json({ success: true });
}
