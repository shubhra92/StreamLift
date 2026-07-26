/**
 * GET /api/worker/status/batch
 *
 * Returns current status for ALL workers owned by the authenticated guest.
 * Used as the polling fallback when SSE is unavailable or has failed.
 *
 * Response: { workers: { [workerId]: WorkerStatusPayload } }
 */

import { NextRequest, NextResponse } from "next/server";
import { workerStore } from "@/app/lib/workerStore";
import { initWorkerStore } from "@/app/lib/initWorkerStore";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ workers: {} }, { status: 401 });
  }

  const guest = await validateGuestToken(token);
  if (!guest) {
    return NextResponse.json({ workers: {} }, { status: 401 });
  }

  await initWorkerStore();

  const guestWorkers = await db
    .select({ id: workers.id })
    .from(workers)
    .where(eq(workers.guestId, guest.id));

  const result: Record<string, object> = {};

  for (const { id } of guestWorkers) {
    const state = workerStore.get(id);
    if (!state) continue;
    result[id] = {
      online:        state.online,
      ipAddress:     state.ipAddress,
      lastHeartbeat: state.lastHeartbeat,
      metrics:       state.metrics,
      currentTask:   state.currentTask,
      logs:          state.logs,
      version:       state.version,
    };
  }

  return NextResponse.json({ workers: result });
}
