/**
 * GET /api/worker/status/stream
 *
 * SSE stream that pushes status for ALL workers owned by the authenticated guest.
 * Pushes every 2 seconds. Each event is:
 *   data: { workerId: string, status: WorkerStatusPayload }
 *
 * Used by the SharedWorker as a single connection for all open WorkerDetails panels.
 * The SharedWorker filters by watchedWorkerIds and broadcasts to relevant tabs only.
 */

import { NextRequest } from "next/server";
import { workerStore } from "@/app/lib/workerStore";
import { initWorkerStore } from "@/app/lib/initWorkerStore";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PUSH_INTERVAL_MS = 2000;

export async function GET(req: NextRequest) {
  // Auth
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
  if (!token) {
    return new Response("Unauthorized", { status: 401 });
  }
  const guest = await validateGuestToken(token);
  if (!guest) {
    return new Response("Unauthorized", { status: 401 });
  }

  await initWorkerStore();

  // Fetch all worker IDs for this guest once at stream open
  // (new workers created during the stream will appear on next reconnect)
  const guestWorkers = await db
    .select({ id: workers.id })
    .from(workers)
    .where(eq(workers.guestId, guest.id));

  const workerIds = guestWorkers.map((w) => w.id);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const push = () => {
        for (const workerId of workerIds) {
          const state = workerStore.get(workerId);
          if (!state) continue;

          const payload = {
            workerId,
            status: {
              online:        state.online,
              ipAddress:     state.ipAddress,
              lastHeartbeat: state.lastHeartbeat,
              metrics:       state.metrics,
              currentTask:   state.currentTask,
              logs:          state.logs,
              version:       state.version,
            },
          };

          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
            );
          } catch {
            // Controller closed — stop
            clearInterval(interval);
            return;
          }
        }
      };

      // Push immediately, then every 2s
      push();
      const interval = setInterval(push, PUSH_INTERVAL_MS);

      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":    "text/event-stream",
      "Cache-Control":   "no-cache, no-transform",
      "Connection":      "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
