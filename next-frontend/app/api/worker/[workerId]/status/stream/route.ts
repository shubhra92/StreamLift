import { NextRequest } from "next/server";
import { workerStore } from "@/app/lib/workerStore";
import { initWorkerStore } from "@/app/lib/initWorkerStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> }
) {
  await initWorkerStore();
  const { workerId } = await params;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        const state = workerStore.get(workerId);
        if (!state) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: "Worker not found" })}\n\n`
            )
          );
          controller.close();
          clearInterval(interval);
          return;
        }

        const payload = {
          online: state.online,
          ipAddress: state.ipAddress,
          lastHeartbeat: state.lastHeartbeat,
          metrics: state.metrics,
          currentTask: state.currentTask,
          logs: state.logs,
          version: state.version,
        };

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
        );
      };

      // Send immediately, then every 2 seconds
      send();
      const interval = setInterval(send, 2000);

      // Clean up when client disconnects
      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
