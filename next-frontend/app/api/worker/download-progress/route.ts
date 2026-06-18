import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { workerStore, updateWorkerHeartbeat } from "@/app/lib/workerStore";
import { initWorkerStore } from "@/app/lib/initWorkerStore";
import { db } from "@/app/db";
import { fileDownloads, workers } from "@/app/db/schema";
import { eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await initWorkerStore();

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }

  const { workerId, authToken, downloadId, progress } = body ?? {};

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing credentials" }, { status: 401 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  if (!downloadId || !progress) {
    return NextResponse.json({ success: false, message: "Missing downloadId or progress" }, { status: 400 });
  }

  // Treat any worker call as a heartbeat — keeps worker online during active downloads
  updateWorkerHeartbeat(workerId);

  const { status, errorMessage, downloadedBytes, totalBytes } = progress;

  // Fetch existing record to preserve fileSize set at creation time
  const [existing] = await db
    .select({ fileSize: fileDownloads.fileSize })
    .from(fileDownloads)
    .where(eq(fileDownloads.id, downloadId))
    .limit(1);

  // Only use totalBytes from the worker if the DB record has no fileSize yet.
  // This prevents aria2c's piece-aligned byte count from overwriting the
  // exact file size that was stored from torrent metadata at creation time.
  const resolvedFileSize = existing?.fileSize ?? totalBytes ?? null;

  // Update download record in DB
  await db
    .update(fileDownloads)
    .set({
      status:       status ?? "downloading",
      errorMessage: errorMessage ?? null,
      fileSize:     resolvedFileSize,
      updatedAt:    new Date(),
    })
    .where(eq(fileDownloads.id, downloadId));

  // Upsert worker store current task from progress report
  const state = workerStore.get(workerId);
  if (state) {
    if (status === "completed" || status === "failed") {
      // Clear task on terminal states
      state.currentTask = null;
    } else {
      // Always keep currentTask in sync with latest progress
      state.currentTask = {
        downloadId,
        fileName: state.currentTask?.fileName ?? downloadId,
        status: status ?? "downloading",
        progress: progress.percent ?? 0,
        startedAt: state.currentTask?.startedAt ?? new Date().toISOString(),
      };
    }
  }

  // On completion, increment worker stats
  if (status === "completed") {
    await db
      .update(workers)
      .set({
        totalDownloads: sql`${workers.totalDownloads} + 1`,
        totalBytes: sql`${workers.totalBytes} + ${totalBytes ?? 0}`,
        updatedAt: new Date(),
      })
      .where(eq(workers.id, workerId));
  }

  return NextResponse.json({ success: true, message: "Progress updated" });
}
