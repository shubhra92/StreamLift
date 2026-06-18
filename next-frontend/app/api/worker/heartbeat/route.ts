import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { workerStore, updateWorkerMetrics, updateWorkerHeartbeat } from "@/app/lib/workerStore";
import { initWorkerStore } from "@/app/lib/initWorkerStore";
import { db } from "@/app/db";
import { fileDownloads } from "@/app/db/schema";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await initWorkerStore();

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }

  const { workerId, authToken, metrics, currentTask } = body ?? {};

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing credentials" }, { status: 401 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  // Update heartbeat and metrics
  updateWorkerHeartbeat(workerId);
  if (metrics) {
    updateWorkerMetrics(workerId, {
      ...metrics,
      timestamp: new Date().toISOString(),
    });
  }

  // Upsert current task from heartbeat
  const state = workerStore.get(workerId);
  if (state && currentTask) {
    state.currentTask = {
      downloadId: currentTask.downloadId,
      fileName: currentTask.fileName ?? state.currentTask?.fileName ?? currentTask.downloadId,
      status: currentTask.status ?? "downloading",
      progress: currentTask.progress ?? state.currentTask?.progress ?? 0,
      startedAt: state.currentTask?.startedAt ?? new Date().toISOString(),
    };
  }

  // Find pending downloads assigned to this worker
  const pendingTasks = await db
    .select()
    .from(fileDownloads)
    .where(
      and(
        eq(fileDownloads.workerId, workerId),
        eq(fileDownloads.status, "pending")
      )
    )
    .limit(3);

  const newTasks = pendingTasks.map((d) => ({
    downloadId:   d.id,
    sourceUrl:    d.sourceUrl,
    fileName:     d.fileName ?? "file",
    fileType:     d.fileType ?? "",
    fileSize:     d.fileSize ?? 0,
    downloadType: d.downloadType ?? "http",
    fileIndices:  d.selectedFileIndices ?? null, // JSON string of indices for torrents
  }));

  return NextResponse.json({ success: true, newTasks });
}
