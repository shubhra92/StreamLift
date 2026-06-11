import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { workerStore, markWorkerOnline, updateWorkerHeartbeat } from "@/app/lib/workerStore";
import { initWorkerStore } from "@/app/lib/initWorkerStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await initWorkerStore();

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }

  const { workerId, authToken, ipAddress, version } = body ?? {};

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing workerId or authToken" }, { status: 401 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  // Ensure state exists
  if (!workerStore.has(workerId)) {
    const { initializeWorkerState } = await import("@/app/lib/workerStore");
    workerStore.set(workerId, initializeWorkerState(workerId));
  }

  markWorkerOnline(workerId, ipAddress ?? "unknown", version);

  return NextResponse.json({
    success: true,
    message: "Worker registered successfully",
    config: {
      pollInterval: 10000,
      heartbeatEndpoint: "/api/worker/heartbeat",
      logsEndpoint: "/api/worker/logs",
      progressEndpoint: "/api/worker/download-progress",
    },
  });
}
