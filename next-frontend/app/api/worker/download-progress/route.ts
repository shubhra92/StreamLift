/**
 * POST /api/worker/download-progress
 *
 * Legacy endpoint kept for backward compatibility with older worker versions.
 * In v2, the worker calls /api/worker/status-update for final state changes.
 * This route still updates the DB so old workers keep working.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { db } from "@/app/db";
import { fileDownloads, workers } from "@/app/db/schema";
import { eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
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

  const { status, errorMessage, totalBytes } = progress;

  const [existing] = await db
    .select({ fileSize: fileDownloads.fileSize })
    .from(fileDownloads)
    .where(eq(fileDownloads.id, downloadId))
    .limit(1);

  const resolvedFileSize = existing?.fileSize ?? totalBytes ?? null;

  await db
    .update(fileDownloads)
    .set({
      status:       status ?? "downloading",
      errorMessage: errorMessage ?? null,
      fileSize:     resolvedFileSize,
      updatedAt:    new Date(),
    })
    .where(eq(fileDownloads.id, downloadId));

  if (status === "completed") {
    await db
      .update(workers)
      .set({
        totalDownloads: sql`${workers.totalDownloads} + 1`,
        totalBytes:     sql`${workers.totalBytes} + ${totalBytes ?? 0}`,
        updatedAt:      new Date(),
      })
      .where(eq(workers.id, workerId));
  }

  return NextResponse.json({ success: true, message: "Progress updated" });
}
