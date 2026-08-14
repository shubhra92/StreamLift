/**
 * GET /api/worker/status/batch
 *
 * Returns online status for ALL workers owned by the authenticated guest.
 * Reads last_heartbeat from DB — no in-memory cache.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";

export const dynamic = "force-dynamic";

const ONLINE_THRESHOLD_MS = 20_000;

export async function GET(req: NextRequest) {
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ workers: {} }, { status: 401 });
  }
  const guest = await validateGuestToken(token);
  if (!guest) {
    return NextResponse.json({ workers: {} }, { status: 401 });
  }

  const guestWorkers = await db
    .select()
    .from(workers)
    .where(eq(workers.guestId, guest.id));

  const result: Record<string, object> = {};

  for (const w of guestWorkers) {
    const online = w.lastHeartbeat
      ? Date.now() - new Date(w.lastHeartbeat).getTime() < ONLINE_THRESHOLD_MS
      : false;

    result[w.id] = {
      online,
      lastHeartbeat: w.lastHeartbeat?.toISOString() ?? null,
      pinggyUrl:     w.pinggyUrl ?? null,
      ipAddress:     w.ipAddress ?? null,
      version:       w.version,
    };
  }

  return NextResponse.json({ workers: result });
}
