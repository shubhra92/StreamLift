import { NextRequest, NextResponse } from "next/server";
import { requireTvDevice } from "@/app/lib/tvAuth";
import { buildTvCatalog } from "@/app/lib/tvCatalog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/tv/catalog
 *
 * Returns the same playable library as the web watch page: every online
 * local-storage worker, every completed download it still has on disk, and
 * every video/audio file inside those downloads.
 *
 * `?force=1` bypasses the short server-side cache (used by pull-to-refresh on
 * the TV). Media bytes are served directly by the worker, not this route.
 */
export async function GET(req: NextRequest) {
  const auth = await requireTvDevice(req);
  if (!auth.ok) return auth.response;

  const force = req.nextUrl.searchParams.get("force") === "1";
  const catalog = await buildTvCatalog(auth.guest.id, { force });

  return NextResponse.json(
    { success: true, ...catalog },
    { headers: { "Cache-Control": "no-store" } },
  );
}
