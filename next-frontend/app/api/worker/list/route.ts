/**
 * GET /api/worker/list?since=<ISO>
 *
 * Returns:
 *  - data:          delta DB rows (workers whose updatedAt >= since). Empty array if nothing changed.
 *  - syncedAt:      server timestamp — client advances its cursor to this value
 *  - runtimeStatus: live workerStore snapshot for ALL guest workers (always included)
 *
 * This MUST be an API route (not a server action) so it shares the same
 * Node.js module instance as heartbeat/register — the routes that write to
 * workerStore. Server actions run in an isolated module context and would
 * always read an empty/stale store.
 */

import { NextRequest, NextResponse } from "next/server";
import { initWorkerStore } from "@/app/lib/initWorkerStore";
import { workerStore } from "@/app/lib/workerStore";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq, and, gte, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const guest = await validateGuestToken(token);
  if (!guest) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // ── Ensure workerStore is warm ──────────────────────────────────────────
  await initWorkerStore();

  const syncedAt = new Date().toISOString();
  const since = req.nextUrl.searchParams.get("since") ?? undefined;

  // ── 1. Delta DB query — only rows changed since cursor ──────────────────
  const conditions = [eq(workers.guestId, guest.id)];
  if (since) {
    conditions.push(gte(workers.updatedAt, new Date(since)));
  }

  // ids_only mode — return just current IDs for reconciliation (no runtimeStatus needed)
  if (req.nextUrl.searchParams.get("ids_only") === "true") {
    const allRows = await db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.guestId, guest.id));
    return NextResponse.json({ ids: allRows.map((r) => r.id), syncedAt });
  }

  const deltaRows = await db
    .select()
    .from(workers)
    .where(and(...conditions))
    .orderBy(desc(workers.createdAt));

  // ── 2. Runtime status — ALL guest workers from workerStore (in-memory) ──
  // Always fetch all IDs so runtimeStatus is a complete snapshot,
  // not just the delta subset.
  let allWorkerIds: string[];
  if (!since) {
    // Full sync — delta already has all rows
    allWorkerIds = deltaRows.map((w) => w.id);
  } else {
    // Delta sync — need separate ID list for the full runtimeStatus snapshot
    const allRows = await db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.guestId, guest.id));
    allWorkerIds = allRows.map((w) => w.id);
  }

  const runtimeStatus: Record<string, {
    online: boolean;
    ipAddress: string | null;
    lastHeartbeat: string | null;
  }> = {};

  for (const id of allWorkerIds) {
    const state = workerStore.get(id);
    runtimeStatus[id] = {
      online:        state?.online        ?? false,
      ipAddress:     state?.ipAddress     ?? null,
      lastHeartbeat: state?.lastHeartbeat ?? null,
    };
  }

  // Strip sensitive fields before sending to client
  const safeRows = deltaRows.map(({ megaPassword: _pw, authToken: _tok, ...rest }) => rest);

  return NextResponse.json({
    success:       true,
    data:          safeRows,
    syncedAt,
    runtimeStatus,
  });
}
