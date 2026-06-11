"use server";

import { db, fileDownloads } from "../db";
import { desc, eq, and } from "drizzle-orm";
import { workerStore } from "../lib/workerStore";
import { workers } from "../db/schema";
import type { FileDownload } from "../db/schema";

/** Resolve which workerId to assign based on the location string */
async function resolveWorkerAssignment(
  location: string
): Promise<{ workerId: string | null; error?: string }> {
  if (location === "all-workers") {
    // Pick the online worker with no current task (lowest load)
    const allWorkers = await db.select().from(workers);
    const candidates = allWorkers
      .map((w) => ({ worker: w, state: workerStore.get(w.id) }))
      .filter(({ state }) => state?.online)
      .sort((a, b) => (a.state?.currentTask ? 1 : 0) - (b.state?.currentTask ? 1 : 0));

    if (candidates.length === 0) {
      // No online workers — queue it (workerId stays null, status pending)
      return { workerId: null };
    }
    return { workerId: candidates[0].worker.id };
  }

  if (location.startsWith("worker-")) {
    const workerId = location.replace("worker-", "");
    const [worker] = await db
      .select()
      .from(workers)
      .where(eq(workers.id, workerId))
      .limit(1);
    if (!worker) return { workerId: null, error: "Worker not found" };
    return { workerId: worker.id };
  }

  return { workerId: null };
}

export async function createDownload(sourceUrl: string, location: string, fileName?: string) {
  const { workerId, error } = await resolveWorkerAssignment(location);
  if (error) throw new Error(error);

  const [data] = await db.insert(fileDownloads).values({
    sourceUrl,
    location,
    workerId,
    fileName: fileName || "default",
    status: "pending",
    downloadType: "http",
  }).returning();

  return data;
}

export async function getDownloads() {
  const downloads = await db
    .select()
    .from(fileDownloads)
    .where(eq(fileDownloads.downloadType, "http"))
    .orderBy(desc(fileDownloads.createdAt));

  return downloads;
}

export async function getDownloadById(fileId: string) {
  const [download] = await db
    .select()
    .from(fileDownloads)
    .where(eq(fileDownloads.id, fileId))
    .limit(1);

  return download;
}

export async function deleteDownload(id: string) {
  // Check if download is currently downloading
  const [existing] = await db.select().from(fileDownloads).where(eq(fileDownloads.id, id));
  if (existing?.status === "downloading") {
    return { success: false, message: "Cannot delete a downloading file" };
  }

  await db.delete(fileDownloads).where(eq(fileDownloads.id, id));
  return { success: true };
}

export async function updateDownload(id: string, data: Partial<Omit<FileDownload, "id"|"createdAt"|"updatedAt">>) {
  // Check if download is still pending (reject if it started downloading)
  const [existing] = await db.select().from(fileDownloads).where(eq(fileDownloads.id, id));
  if (!existing) {
    return { success: false, message: "Download not found" };
  }

  if(data.status === "failed" && data.errorMessage){
    data = {
      status: "failed",
      errorMessage: data.errorMessage
    }
  } else if (existing.status !== "pending") {
    return { success: false, message: "Cannot edit a download that is no longer pending" };
  }

  const [updated] = await db.update(fileDownloads)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(fileDownloads.id, id))
    .returning();

  return { success: true, data: updated };
}
