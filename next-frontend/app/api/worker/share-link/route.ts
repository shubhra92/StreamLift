/**
 * POST /api/worker/share-link
 *
 * Called by the Python worker after it mints a MEGA share link for a download
 * it uploaded. Persists the URL so the download/external icons survive the
 * worker going offline. Best-effort from the worker's perspective; the
 * frontend can retry by calling the share endpoint again.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { db } from "@/app/db";
import { fileDownloads } from "@/app/db/schema";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }

  const { workerId, authToken, downloadId, cloudShareUrl } = body ?? {};

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing credentials" }, { status: 401 });
  }
  if (!downloadId || typeof cloudShareUrl !== "string" || !cloudShareUrl) {
    return NextResponse.json({ success: false, message: "Missing downloadId or cloudShareUrl" }, { status: 400 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  // Only bind a share URL to a download this worker actually owns.
  const owned = await db
    .select({ id: fileDownloads.id })
    .from(fileDownloads)
    .where(and(eq(fileDownloads.id, downloadId), eq(fileDownloads.workerId, workerId)))
    .limit(1);

  if (owned.length === 0) {
    return NextResponse.json({ success: false, message: "Download not owned by this worker" }, { status: 404 });
  }

  await db
    .update(fileDownloads)
    .set({ cloudShareUrl, updatedAt: new Date() })
    .where(eq(fileDownloads.id, downloadId));

  return NextResponse.json({ success: true });
}