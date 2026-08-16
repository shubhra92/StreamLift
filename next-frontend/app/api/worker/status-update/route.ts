/**
 * POST /api/worker/status-update
 *
 * Called by the Python worker when a download status changes.
 * Updates the file_downloads row and, on completion, increments worker stats.
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

  const { workerId, authToken, downloadId, status, errorMessage, locationPath } = body ?? {};

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing credentials" }, { status: 401 });
  }

  if (!downloadId || !status) {
    return NextResponse.json({ success: false, message: "Missing downloadId or status" }, { status: 400 });
  }

  const validStatuses = ["pending", "downloading", "uploading", "completed", "failed"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ success: false, message: `Invalid status: ${status}` }, { status: 400 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  // Update the download record
  const [updated] = await db
    .update(fileDownloads)
    .set({
      status,
      ...(errorMessage ? { errorMessage } : {}),
      ...(typeof locationPath === "string" && locationPath ? { locationPath } : {}),
      updatedAt: new Date(),
    })
    .where(eq(fileDownloads.id, downloadId))
    .returning({ fileSize: fileDownloads.fileSize });

  // On completion, increment worker stats
  if (status === "completed") {
    const bytesTransferred = updated?.fileSize ?? 0;
    await db
      .update(workers)
      .set({
        totalDownloads: sql`${workers.totalDownloads} + 1`,
        totalBytes:     sql`${workers.totalBytes} + ${bytesTransferred}`,
        updatedAt:      new Date(),
      })
      .where(eq(workers.id, workerId));
  }

  return NextResponse.json({ success: true });
}
