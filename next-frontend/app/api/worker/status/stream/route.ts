/**
 * GET /api/worker/status/stream
 *
 * SSE stream pushing online status for ALL workers owned by the guest.
 * Reads last_heartbeat from DB every 5s — no in-memory cache.
 *
 * Note: live metrics and task progress are now streamed directly from the
 * worker's own /stream SSE endpoint. This route only covers online/offline status.
 */

import { NextRequest } from "next/server";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PUSH_INTERVAL_MS   = 5_000;
const ONLINE_THRESHOLD_MS = 20_000;

export async function GET(req: NextRequest) {
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
  if (!token) return new Response("Unauthorized", { status: 401 });

  const guest = await validateGuestToken(token);
  if (!guest) return new Response("Unauthorized", { status: 401 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const push = async () => {
        try {
          const guestWorkers = await db
            .select()
            .from(workers)
            .where(eq(workers.guestId, guest.id));

          for (const w of guestWorkers) {
            const online = w.lastHeartbeat
              ? Date.now() - new Date(w.lastHeartbeat).getTime() < ONLINE_THRESHOLD_MS
              : false;

            const payload = {
              workerId: w.id,
              status: {
                online,
                lastHeartbeat: w.lastHeartbeat?.toISOString() ?? null,
                pinggyUrl:     w.pinggyUrl ?? null,
                version:       w.version,
              },
            };

            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
            );
          }
        } catch {
          // DB error — skip this tick
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
