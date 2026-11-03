/**
 * GET /api/worker/status/batch
 *
 * Returns online status for ALL workers owned by the authenticated workspace.
 * Reads last_heartbeat from DB — no in-memory cache.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";
import { requireWorkspaceId } from "@/app/lib/sessionAuth";
import { clearStaleWorkerConnections, isWorkerOnline } from "@/app/lib/workerPresence";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireWorkspaceId(req);
  if (!auth.ok) return NextResponse.json({ workers: {} }, { status: 401 });
  const workspaceId = auth.workspaceId;

  await clearStaleWorkerConnections(workspaceId);

  const workspaceWorkers = await db
    .select()
    .from(workers)
    .where(eq(workers.workspaceId, workspaceId));

  const result: Record<string, object> = {};

  for (const w of workspaceWorkers) {
    const online = isWorkerOnline(w.lastHeartbeat);

    result[w.id] = {
      online,
      lastHeartbeat: w.lastHeartbeat?.toISOString() ?? null,
      tunnelUrl:     w.tunnelUrl ?? null,
      ipAddress:     w.ipAddress ?? null,
      version:       w.version,
    };
  }

  return NextResponse.json({ workers: result });
}
