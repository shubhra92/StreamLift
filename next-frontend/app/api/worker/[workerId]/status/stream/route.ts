/**
 * GET /api/worker/[workerId]/status/stream
 *
 * Legacy SSE route — kept for backward compat.
 * In v2, the client connects directly to the worker's own /stream endpoint
 * for live metrics and task progress.
 * This route now only pushes online/offline status from DB last_heartbeat.
 */

import { NextRequest } from "next/server";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";
import { clearStaleWorkerConnections, isWorkerOnline } from "@/app/lib/workerPresence";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PUSH_INTERVAL_MS    = 5_000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> },
) {
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
  if (!token) return new Response("Unauthorized", { status: 401 });

  const guest = await validateGuestToken(token);
  if (!guest) return new Response("Unauthorized", { status: 401 });

  const { workerId } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const push = async () => {
        try {
          await clearStaleWorkerConnections(guest.id);
          const [worker] = await db
            .select({ id: workers.id, guestId: workers.guestId, lastHeartbeat: workers.lastHeartbeat, pinggyUrl: workers.pinggyUrl, version: workers.version })
            .from(workers)
            .where(eq(workers.id, workerId))
            .limit(1);

          if (!worker || worker.guestId !== guest.id) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "Worker not found" })}\n\n`));
            controller.close();
            clearInterval(interval);
            return;
          }

          const online = isWorkerOnline(worker.lastHeartbeat);

          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            online,
            lastHeartbeat: worker.lastHeartbeat?.toISOString() ?? null,
            pinggyUrl:     worker.pinggyUrl ?? null,
            version:       worker.version,
          })}\n\n`));
        } catch {
          // DB error — skip tick
        }
      };

      await push();
      const interval = setInterval(push, PUSH_INTERVAL_MS);

      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache, no-transform",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
