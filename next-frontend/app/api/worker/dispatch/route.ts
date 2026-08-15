/**
 * POST /api/worker/dispatch
 *
 * Called by the SharedWorker after every sync cycle.
 * 1. Marks stuck downloads as failed (worker offline > 1.5 min)
 * 2. Finds the next pending download to dispatch (FIFO)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/db";
import { fileDownloads, workers } from "@/app/db/schema";
import { and, eq, inArray, asc } from "drizzle-orm";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";
import { isSessionTokenExpired, rotateSessionToken } from "@/app/lib/sessionToken";

export const dynamic = "force-dynamic";

const ONLINE_THRESHOLD_MS = 20_000;   // worker considered offline after 20s
const STUCK_THRESHOLD_MS  = 90_000;   // 1.5 minutes — mark failed if worker offline this long
const SERVER_LOCATIONS    = ["server", "cloud", "mega"];

function isWorkerLocation(location: string | null): boolean {
  if (!location) return false;
  return location.startsWith("worker-") || location === "all-workers";
}

function isServerLocation(location: string | null): boolean {
  if (!location) return false;
  return SERVER_LOCATIONS.some((l) => location === l);
}

export async function POST(req: NextRequest) {
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
  if (!token) return NextResponse.json({ action: "none" }, { status: 401 });

  const guest = await validateGuestToken(token);
  if (!guest) return NextResponse.json({ action: "none" }, { status: 401 });

  const now = Date.now();

  // ── 0. Mark stuck downloads as failed ────────────────────────────────────
  // Conditions: status=downloading/uploading AND assigned worker has been
  // offline for > STUCK_THRESHOLD_MS AND row hasn't been updated in that time.
  const activeDownloads = await db
    .select()
    .from(fileDownloads)
    .where(
      and(
        eq(fileDownloads.guestId, guest.id),
        inArray(fileDownloads.status, ["downloading", "uploading"]),
      )
    );

  if (activeDownloads.length > 0) {
    const allWorkers = await db
      .select({ id: workers.id, lastHeartbeat: workers.lastHeartbeat })
      .from(workers)
      .where(eq(workers.guestId, guest.id));

    const workerLastSeen = new Map(allWorkers.map((w) => [w.id, w.lastHeartbeat]));

    for (const d of activeDownloads) {
      if (!d.workerId) continue;

      const lastHeartbeat = workerLastSeen.get(d.workerId);
      const workerOffline = !lastHeartbeat ||
        now - new Date(lastHeartbeat).getTime() > ONLINE_THRESHOLD_MS;

      if (!workerOffline) continue;

      // Worker is offline — check if the row has been stuck long enough
      const stuckSince    = d.updatedAt ? new Date(d.updatedAt).getTime() : 0;
      const stuckDuration = now - stuckSince;

      if (stuckDuration > STUCK_THRESHOLD_MS) {
        await db
          .update(fileDownloads)
          .set({
            status:       "failed",
            errorMessage: "Worker went offline during download — please retry",
            updatedAt:    new Date(),
          })
          .where(eq(fileDownloads.id, d.id));
      }
    }
  }

  // ── 1. Get all pending downloads ordered oldest first ─────────────────────
  const pending = await db
    .select()
    .from(fileDownloads)
    .where(
      and(
        eq(fileDownloads.guestId, guest.id),
        eq(fileDownloads.status, "pending"),
      )
    )
    .orderBy(asc(fileDownloads.createdAt))
    .limit(20);

  if (pending.length === 0) return NextResponse.json({ action: "none" });

  // ── 2. Get all currently downloading rows ────────────────────────────────
  const downloading = await db
    .select({ workerId: fileDownloads.workerId, location: fileDownloads.location })
    .from(fileDownloads)
    .where(
      and(
        eq(fileDownloads.guestId, guest.id),
        inArray(fileDownloads.status, ["downloading", "uploading"]),
      )
    );

  const busyWorkerIds = new Set(
    downloading.filter((d) => d.workerId).map((d) => d.workerId as string)
  );
  const serverBusy = downloading.some((d) => isServerLocation(d.location));

  // ── 3. Get all online workers ─────────────────────────────────────────────
  const allWorkers = await db
    .select()
    .from(workers)
    .where(eq(workers.guestId, guest.id));

  const onlineWorkerMap = new Map(
    allWorkers
      .filter((w) =>
        w.lastHeartbeat
          ? now - new Date(w.lastHeartbeat).getTime() < ONLINE_THRESHOLD_MS
          : false
      )
      .map((w) => [w.id, w])
  );

  // ── 4. Find the first pending download with an available destination ──────
  for (const download of pending) {
    const loc = download.location ?? "";

    if (isServerLocation(loc)) {
      if (serverBusy) continue;
      return NextResponse.json({
        action:   "trigger",
        download: {
          id:                  download.id,
          sourceUrl:           download.sourceUrl,
          fileName:            download.fileName,
          location:            download.location,
          downloadType:        download.downloadType,
          selectedFileIndices: download.selectedFileIndices,
          workerId:            null,
        },
        destination: "server",
      });
    }

    if (isWorkerLocation(loc)) {
      const workerId = download.workerId;
      if (!workerId) continue;
      if (busyWorkerIds.has(workerId)) continue;
      const worker = onlineWorkerMap.get(workerId);
      if (!worker || !worker.pinggyUrl) continue;

      let sessionToken = worker.sessionToken;
      if (isSessionTokenExpired(worker.sessionTokenExpiry)) {
        try {
          sessionToken = await rotateSessionToken(workerId, worker.pinggyUrl, worker.authToken);
        } catch {
          continue;
        }
      }

      // Browser-dispatched worker jobs must use HTTPS when the dashboard is
      // deployed on Vercel. Older TCP workers are skipped until restarted.
      if (!worker.pinggyUrl.startsWith("https://")) continue;

      return NextResponse.json({
        action:      "trigger",
        download: {
          id:                  download.id,
          sourceUrl:           download.sourceUrl,
          fileName:            download.fileName,
          location:            download.location,
          downloadType:        download.downloadType,
          selectedFileIndices: download.selectedFileIndices,
          workerId,
        },
        destination: "worker",
        pinggyUrl:   worker.pinggyUrl,
        sessionToken,
      });
    }
  }

  return NextResponse.json({ action: "none" });
}
