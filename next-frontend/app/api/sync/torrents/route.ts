/**
 * GET /api/sync/torrents?since=<ISO>
 *
 * Called by the SharedWorker. Returns delta rows for torrent downloads.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";
import { db } from "@/app/db";
import { fileDownloads } from "@/app/db/schema";
import { eq, and, gte, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
  if (!token) return NextResponse.json({ data: [], syncedAt: new Date().toISOString() });

  const guest = await validateGuestToken(token);
  if (!guest) return NextResponse.json({ data: [], syncedAt: new Date().toISOString() });

  const syncedAt = new Date().toISOString();
  const since   = req.nextUrl.searchParams.get("since")    ?? undefined;
  const idsOnly = req.nextUrl.searchParams.get("ids_only") === "true";

  const conditions = [
    eq(fileDownloads.downloadType, "torrent"),
    eq(fileDownloads.guestId, guest.id),
  ];

  if (since) {
    conditions.push(gte(fileDownloads.updatedAt, new Date(since)));
  }

  if (idsOnly) {
    const rows = await db
      .select({ id: fileDownloads.id })
      .from(fileDownloads)
      .where(and(
        eq(fileDownloads.downloadType, "torrent"),
        eq(fileDownloads.guestId, guest.id),
      ));
    return NextResponse.json({ ids: rows.map((r) => r.id), syncedAt });
  }

  const data = await db
    .select()
    .from(fileDownloads)
    .where(and(...conditions))
    .orderBy(desc(fileDownloads.createdAt));

  return NextResponse.json({ data, syncedAt });
}
