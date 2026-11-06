"use server";

import { db, fileDownloads } from "../db";
import { desc, eq, and, inArray } from "drizzle-orm";
import { workers } from "../db/schema";
import { getWorkspaceId } from "../lib/getWorkspaceId";
import type { FileDownload } from "../db/schema";

const ONLINE_THRESHOLD_MS = 20_000; // 20 seconds

/** Resolve which workerId to assign based on the location string.
 *  Uses DB last_heartbeat for online check — no in-memory store. */
async function resolveWorkerAssignment(
  location: string,
  workspaceId: string
): Promise<{ workerId: string | null; error?: string }> {
  if (location === "all-workers") {
    const allWorkers = await db
      .select()
      .from(workers)
      .where(eq(workers.workspaceId, workspaceId));

    // Pick an online idle worker — prefer ones with no current session token activity
    const now = Date.now();
    const candidates = allWorkers.filter((w) =>
      w.lastHeartbeat
        ? now - new Date(w.lastHeartbeat).getTime() < ONLINE_THRESHOLD_MS
        : false
    );

    if (candidates.length === 0) return { workerId: null };
    return { workerId: candidates[0].id };
  }

  if (location.startsWith("worker-")) {
    const workerId = location.replace("worker-", "");
    const [worker] = await db
      .select()
      .from(workers)
      .where(and(eq(workers.id, workerId), eq(workers.workspaceId, workspaceId)))
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
  downloadType: "http" | "hls" = "http",
) {
  const workspaceId = await getWorkspaceId();
  if (!workspaceId) throw new Error("Unauthorized");
  const { workerId, error } = await resolveWorkerAssignment(location, workspaceId);
  if (error) throw new Error(error);

  if (downloadType === "hls") {
    if (!location?.startsWith("worker-")) {
      throw new Error("HLS downloads must be assigned to a worker.");
    }
  }

  const dt = downloadType === "hls" ? "hls" : "http";

  const [data] = await db.insert(fileDownloads).values({
    workspaceId: workspaceId ?? undefined,
    sourceUrl,
    location,
    workerId,
    fileName: fileName || "default",
    status: "pending",
    downloadType: dt,
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
  const workspaceId = await getWorkspaceId();
  if (!workspaceId) return { data: [], syncedAt: new Date().toISOString() };

  const syncedAt = new Date().toISOString();

  const conditions = [
    eq(fileDownloads.downloadType, "http"),
    eq(fileDownloads.workspaceId, workspaceId),
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

export async function getAllDownloads(
  since?: string
): Promise<DeltaSyncResult<FileDownload>> {
  const workspaceId = await getWorkspaceId();
  if (!workspaceId) return { data: [], syncedAt: new Date().toISOString() };

  const syncedAt = new Date().toISOString();

  const conditions = [eq(fileDownloads.workspaceId, workspaceId)];

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
  const workspaceId = await getWorkspaceId();
  if (!workspaceId) return { success: false };

  // UPDATE WHERE status = 'pending' — only succeeds for one caller
  const [claimed] = await db
    .update(fileDownloads)
    .set({ status: "downloading", updatedAt: new Date() })
    .where(
      and(
        eq(fileDownloads.id, id),
        eq(fileDownloads.workspaceId, workspaceId),
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
  const workspaceId = await getWorkspaceId();
  if (!workspaceId) return undefined;

  const [download] = await db
    .select()
    .from(fileDownloads)
    .where(and(eq(fileDownloads.id, fileId), eq(fileDownloads.workspaceId, workspaceId)))
    .limit(1);

  return download;
}

export async function deleteDownload(id: string) {
  const workspaceId = await getWorkspaceId();
  if (!workspaceId) return { success: false, message: "Unauthorized" };

  const [existing] = await db
    .select()
    .from(fileDownloads)
    .where(and(eq(fileDownloads.id, id), eq(fileDownloads.workspaceId, workspaceId)));

  if (!existing) return { success: false, message: "Download not found" };
  if (existing.status === "downloading") {
    return { success: false, message: "Cannot delete a downloading file" };
  }

  await db.delete(fileDownloads).where(eq(fileDownloads.id, id));
  return { success: true };
}

export interface BulkDeleteResult {
  /** False only for a whole-batch failure (auth/db); per-row issues go in `failed` */
  success: boolean;
  message?: string;
  deletedIds: string[];
  failed: { id: string; message: string }[];
}

/**
 * Deletes many rows in a single SQL statement instead of N round-trips.
 * Rows that are missing or still downloading are reported per-id and skipped.
 */
export async function deleteDownloads(ids: string[]): Promise<BulkDeleteResult> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);

  const workspaceId = await getWorkspaceId();
  if (!workspaceId) {
    return {
      success: false,
      message: "Unauthorized",
      deletedIds: [],
      failed: uniqueIds.map((id) => ({ id, message: "Unauthorized" })),
    };
  }

  if (uniqueIds.length === 0) {
    return { success: true, deletedIds: [], failed: [] };
  }

  try {
    const rows = await db
      .select()
      .from(fileDownloads)
      .where(
        and(
          eq(fileDownloads.workspaceId, workspaceId),
          inArray(fileDownloads.id, uniqueIds)
        )
      );

    const byId = new Map(rows.map((row) => [row.id, row]));
    const deletableIds: string[] = [];
    const failed: { id: string; message: string }[] = [];

    for (const id of uniqueIds) {
      const row = byId.get(id);
      if (!row) {
        failed.push({ id, message: "Download not found" });
      } else if (row.status === "downloading") {
        failed.push({ id, message: "Cannot delete a downloading file" });
      } else {
        deletableIds.push(id);
      }
    }

    if (deletableIds.length > 0) {
      await db
        .delete(fileDownloads)
        .where(
          and(
            eq(fileDownloads.workspaceId, workspaceId),
            inArray(fileDownloads.id, deletableIds)
          )
        );
    }

    return { success: true, deletedIds: deletableIds, failed };
  } catch (error) {
    console.error("Failed to bulk delete downloads:", error);
    return {
      success: false,
      message: "Failed to delete downloads",
      deletedIds: [],
      failed: uniqueIds.map((id) => ({
        id,
        message: "Failed to delete this download",
      })),
    };
  }
}

export async function updateDownload(id: string, data: Partial<Omit<FileDownload, "id" | "createdAt" | "updatedAt">>) {
  const workspaceId = await getWorkspaceId();
  if (!workspaceId) return { success: false, message: "Unauthorized" };

  const [existing] = await db
    .select()
    .from(fileDownloads)
    .where(and(eq(fileDownloads.id, id), eq(fileDownloads.workspaceId, workspaceId)));

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
