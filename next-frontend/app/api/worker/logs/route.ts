import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { addWorkerLog, updateWorkerHeartbeat } from "@/app/lib/workerStore";
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

  const { workerId, authToken, logs } = body ?? {};

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing credentials" }, { status: 401 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  if (Array.isArray(logs)) {
    updateWorkerHeartbeat(workerId); // treat log submission as activity
    for (const log of logs) {
      addWorkerLog(workerId, {
        timestamp: log.timestamp ?? new Date().toISOString(),
        level: log.level ?? "info",
        message: log.message ?? "",
      });
    }
  }

  return NextResponse.json({ success: true, message: "Logs received" });
}
