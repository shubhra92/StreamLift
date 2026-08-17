/**
 * GET /api/worker/list?since=<ISO>
 *
 * Returns:
 *  - data:          delta DB rows (workers whose updatedAt >= since)
 *  - syncedAt:      server timestamp — client advances cursor to this value
 *  - runtimeStatus: online status derived from last_heartbeat in DB
 */

import { NextRequest, NextResponse } from "next/server";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import { clearStaleWorkerConnections, isWorkerOnline } from "@/app/lib/workerPresence";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
  const guest = await validateGuestToken(token);
  if (!guest) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  await clearStaleWorkerConnections(guest.id);

  const syncedAt = new Date().toISOString();
  const since    = req.nextUrl.searchParams.get("since") ?? undefined;

  // ids_only mode for reconciliation
  if (req.nextUrl.searchParams.get("ids_only") === "true") {
    const allRows = await db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.guestId, guest.id));
    return NextResponse.json({ ids: allRows.map((r) => r.id), syncedAt });
  }

  // Delta DB query
  const conditions = [eq(workers.guestId, guest.id)];
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
      .where(eq(workers.guestId, guest.id));
    allWorkerIds = allRows.map((w) => w.id);
  }

  // Derive online status from DB last_heartbeat — no in-memory store needed
  const allWorkers = await db
    .select({ id: workers.id, lastHeartbeat: workers.lastHeartbeat, pinggyUrl: workers.pinggyUrl, ipAddress: workers.ipAddress })
    .from(workers)
    .where(eq(workers.guestId, guest.id));

  const now = Date.now();
  const runtimeStatus: Record<string, {
    online:        boolean;
    lastHeartbeat: string | null;
    pinggyUrl:     string | null;
    ipAddress:     string | null;
  }> = {};

  for (const w of allWorkers) {
    const online = isWorkerOnline(w.lastHeartbeat, now);
    runtimeStatus[w.id] = {
      online,
      lastHeartbeat: w.lastHeartbeat?.toISOString() ?? null,
      pinggyUrl:     w.pinggyUrl ?? null,
      ipAddress:     w.ipAddress ?? null,
    };
  }

  // Strip sensitive fields before sending to client
  const safeRows = deltaRows.map(({ megaPassword: _pw, authToken: _tok, pinggyToken: _pt, sessionToken: _st, ...rest }) => rest);

  return NextResponse.json({
    success: true,
    data:    safeRows,
    syncedAt,
    runtimeStatus,
  });
}
