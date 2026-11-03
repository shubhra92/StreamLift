/**
 * GET /api/worker/list?since=<ISO>
 *
 * Returns:
 *  - data:          delta DB rows (workers whose updatedAt >= since)
 *  - syncedAt:      server timestamp — client advances cursor to this value
 *  - runtimeStatus: online status derived from last_heartbeat in DB
 */

import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceId } from "@/app/lib/sessionAuth";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import { clearStaleWorkerConnections, isWorkerOnline } from "@/app/lib/workerPresence";
import { getTunnelBypassHeaders } from "@/app/lib/tunnelHeaders";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireWorkspaceId(req);
  if (!auth.ok) return auth.response;
  const workspaceId = auth.workspaceId;

  await clearStaleWorkerConnections(workspaceId);

  const syncedAt = new Date().toISOString();
  const since    = req.nextUrl.searchParams.get("since") ?? undefined;

  // ids_only mode for reconciliation
  if (req.nextUrl.searchParams.get("ids_only") === "true") {
    const allRows = await db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.workspaceId, workspaceId));
    return NextResponse.json({ ids: allRows.map((r) => r.id), syncedAt });
  }

  // Delta DB query
  const conditions = [eq(workers.workspaceId, workspaceId)];
  if (since) {
    conditions.push(gte(workers.updatedAt, new Date(since)));
  }

  const deltaRows = await db
    .select()
    .from(workers)
    .where(and(...conditions))
    .orderBy(desc(workers.createdAt));

  // All IDs for runtimeStatus snapshot
  let allWorkerIds: string[];
  if (!since) {
    allWorkerIds = deltaRows.map((w) => w.id);
  } else {
    const allRows = await db
      .select({ id: workers.id, lastHeartbeat: workers.lastHeartbeat })
      .from(workers)
      .where(eq(workers.workspaceId, workspaceId));
    allWorkerIds = allRows.map((w) => w.id);
  }

  // Derive online status from DB last_heartbeat — no in-memory store needed
  const allWorkers = await db
    .select({ id: workers.id, lastHeartbeat: workers.lastHeartbeat, tunnelUrl: workers.tunnelUrl, ipAddress: workers.ipAddress })
    .from(workers)
    .where(eq(workers.workspaceId, workspaceId));

  const now = Date.now();
  const runtimeStatus: Record<string, {
    online:        boolean;
    lastHeartbeat: string | null;
    tunnelUrl:     string | null;
    tunnelHeaders: Record<string, string>;
    ipAddress:     string | null;
  }> = {};

  for (const w of allWorkers) {
    const online = isWorkerOnline(w.lastHeartbeat, now);
    runtimeStatus[w.id] = {
      online,
      lastHeartbeat: w.lastHeartbeat?.toISOString() ?? null,
      tunnelUrl:     w.tunnelUrl ?? null,
      tunnelHeaders: w.tunnelUrl ? getTunnelBypassHeaders(w.tunnelUrl) : {},
      ipAddress:     w.ipAddress ?? null,
    };
  }

  // Strip sensitive fields before sending to client
  const safeRows = deltaRows.map(({ megaSession: _ms, authToken: _tok, tunnelConfig: _tc, sessionToken: _st, ...rest }) => rest);

  return NextResponse.json({
    success: true,
    data:    safeRows,
    syncedAt,
    runtimeStatus,
  });
}
