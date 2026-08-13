"use server";

import { db, fileDownloads } from "../db";
import { desc, eq, and } from "drizzle-orm";
import { workerStore } from "../lib/workerStore";
import { workers } from "../db/schema";
import { getGuestId } from "../lib/getGuestId";
import type { FileDownload } from "../db/schema";

/** Resolve which workerId to assign based on the location string */
async function resolveWorkerAssignment(
  location: string,
  guestId: string
): Promise<{ workerId: string | null; error?: string }> {
  if (location === "all-workers") {
    const allWorkers = await db
      .select()
      .from(workers)
      .where(eq(workers.guestId, guestId));

    const candidates = allWorkers
      .map((w) => ({ worker: w, state: workerStore.get(w.id) }))
      .filter(({ state }) => state?.online)
      .sort((a, b) => (a.state?.currentTask ? 1 : 0) - (b.state?.currentTask ? 1 : 0));

    if (candidates.length === 0) {
      return { workerId: null };
    }
    return { workerId: candidates[0].worker.id };
  }

  if (location.startsWith("worker-")) {
    const workerId = location.replace("worker-", "");
    const [worker] = await db
      .select()
      .from(workers)
      .where(and(eq(workers.id, workerId), eq(workers.guestId, guestId)))
      .limit(1);
    if (!worker) return { workerId: null, error: "Worker not found" };
    return { workerId: worker.id };
  }

  return { workerId: null };
}

export async function createDownload(
  sourceUrl: string,
  location: string,
  fileName?: string,
  fileSize?: number | null,
  fileType?: string | null,
) {
  const guestId = await getGuestId();
  if (!guestId) throw new Error("Unauthorized");
  const { workerId, error } = await resolveWorkerAssignment(location, guestId);
  if (error) throw new Error(error);

  const [data] = await db.insert(fileDownloads).values({
    guestId: guestId ?? undefined,
    sourceUrl,
    location,
    workerId,
    fileName: fileName || "default",
    status: "pending",
    downloadType: "http",
    ...(fileSize != null && { fileSize }),
    ...(fileType   && { fileType }),
  }).returning();

  return data;
}

export interface DeltaSyncResult<T> {
  data: T[];
  syncedAt: string; // ISO timestamp — client should advance its cursor to this value
}

export async function getDownloads(
  since?: string
): Promise<DeltaSyncResult<FileDownload>> {
  const guestId = await getGuestId();
  if (!guestId) return { data: [], syncedAt: new Date().toISOString() };

  const syncedAt = new Date().toISOString();

  const conditions = [
    eq(fileDownloads.downloadType, "http"),
    eq(fileDownloads.guestId, guestId),
  ];

  // Delta sync: only return rows updated after the cursor
  if (since) {
    const { gte } = await import("drizzle-orm");
    conditions.push(gte(fileDownloads.updatedAt, new Date(since)));
  }

  const data = await db
    .select()
    .from(fileDownloads)
    .where(and(...conditions))
    .orderBy(desc(fileDownloads.createdAt));

  return { data, syncedAt };
}

/**
 * Atomically claim a pending download by transitioning it from
 * 'pending' → 'downloading' using a conditional UPDATE.
 *
 * Only ONE caller across all tabs/requests will get success:true —
 * the first to execute the UPDATE. All others find the row already
 * 'downloading' and get success:false, so they skip calling Express.
 *
 * This is a database-level compare-and-swap — safe against any number
 * of concurrent callers regardless of timing.
 */
export async function claimDownload(
  id: string
): Promise<{ success: boolean; data?: FileDownload }> {
  const guestId = await getGuestId();
  if (!guestId) return { success: false };

  // UPDATE WHERE status = 'pending' — only succeeds for one caller
  const [claimed] = await db
    .update(fileDownloads)
    .set({ status: "downloading", updatedAt: new Date() })
    .where(
      and(
        eq(fileDownloads.id, id),
        eq(fileDownloads.guestId, guestId),
        eq(fileDownloads.status, "pending")
      )
    )
    .returning();

  if (!claimed) {
    // Row was already claimed by another tab or wasn't pending
    return { success: false };
  }

  return { success: true, data: claimed };
}

export async function getDownloadById(fileId: string) {
  const guestId = await getGuestId();
  if (!guestId) return undefined;

  const [download] = await db
    .select()
    .from(fileDownloads)
    .where(and(eq(fileDownloads.id, fileId), eq(fileDownloads.guestId, guestId)))
    .limit(1);

  return download;
}

export async function deleteDownload(id: string) {
  const guestId = await getGuestId();
  if (!guestId) return { success: false, message: "Unauthorized" };

  const [existing] = await db
    .select()
    .from(fileDownloads)
    .where(and(eq(fileDownloads.id, id), eq(fileDownloads.guestId, guestId)));

  if (!existing) return { success: false, message: "Download not found" };
  if (existing.status === "downloading") {
    return { success: false, message: "Cannot delete a downloading file" };
  }

  await db.delete(fileDownloads).where(eq(fileDownloads.id, id));
  return { success: true };
}

export async function updateDownload(id: string, data: Partial<Omit<FileDownload, "id" | "createdAt" | "updatedAt">>) {
  const guestId = await getGuestId();
  if (!guestId) return { success: false, message: "Unauthorized" };

  const [existing] = await db
    .select()
    .from(fileDownloads)
    .where(and(eq(fileDownloads.id, id), eq(fileDownloads.guestId, guestId)));

  if (!existing) {
    return { success: false, message: "Download not found" };
  }

  // Always allow marking as failed — downloads can fail from any status
  // (pending, downloading, uploading). Only restrict other edits to pending rows.
  if (data.status === "failed") {
    data = { status: "failed", errorMessage: data.errorMessage ?? "Unknown error" };
  } else if (data.status === "pending" && existing.status === "downloading") {
    // Allow reverting downloading → pending when Express start fails
    data = { status: "pending" };
  } else if (existing.status !== "pending") {
    return { success: false, message: "Cannot edit a download that is no longer pending" };
  }

  const [updated] = await db
    .update(fileDownloads)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(fileDownloads.id, id))
    .returning();

  return { success: true, data: updated };
}
