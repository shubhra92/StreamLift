import { NextRequest, NextResponse } from "next/server";
import { workerStore } from "@/app/lib/workerStore";
import { initWorkerStore } from "@/app/lib/initWorkerStore";

export const dynamic = "force-dynamic";

// Polling fallback — returns current state as JSON
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> }
) {
  await initWorkerStore();
  const { workerId } = await params;

  const state = workerStore.get(workerId);
  if (!state) {
    return NextResponse.json({ success: false, message: "Worker not found" }, { status: 404 });
  }

  return NextResponse.json({
    online: state.online,
    ipAddress: state.ipAddress,
    lastHeartbeat: state.lastHeartbeat,
    metrics: state.metrics,
    currentTask: state.currentTask,
    logs: state.logs,
    version: state.version,
  });
}
