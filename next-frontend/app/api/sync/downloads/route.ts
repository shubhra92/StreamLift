/**
 * GET /api/sync/downloads?since=<ISO>
 *
 * Called by the SharedWorker (which cannot use Next.js server actions).
 * Returns delta rows for all file downloads (http + torrent) scoped to the authenticated workspace.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceId } from "@/app/lib/sessionAuth";
import { db } from "@/app/db";
import { fileDownloads } from "@/app/db/schema";
import { eq, and, gte, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireWorkspaceId(req);
  if (!auth.ok) return NextResponse.json({ data: [], syncedAt: new Date().toISOString() });
  const workspaceId = auth.workspaceId;

  const syncedAt = new Date().toISOString();
  const since    = req.nextUrl.searchParams.get("since")    ?? undefined;
  const idsOnly  = req.nextUrl.searchParams.get("ids_only") === "true";

  const conditions = [
    eq(fileDownloads.workspaceId, workspaceId),
  ];

  if (since) {
    conditions.push(gte(fileDownloads.updatedAt, new Date(since)));
  }

  // ids_only mode — return just the current IDs for reconciliation
  // No `since` filter here — we need ALL current IDs to detect orphans
  if (idsOnly) {
    const rows = await db
      .select({ id: fileDownloads.id })
      .from(fileDownloads)
      .where(eq(fileDownloads.workspaceId, workspaceId));
    return NextResponse.json({ ids: rows.map((r) => r.id), syncedAt });
  }

  const data = await db
    .select()
    .from(fileDownloads)
    .where(and(...conditions))
    .orderBy(desc(fileDownloads.createdAt));

  return NextResponse.json({ data, syncedAt });
}
