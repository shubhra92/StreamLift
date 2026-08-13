"use server";

import { db, fileDownloads, workers } from "../db";
import { eq, desc, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { workerStore } from "../lib/workerStore";
import { getGuestId } from "../lib/getGuestId";

async function resolveWorkerForTorrent(location: string, guestId: string): Promise<string | null> {
  if (location === "all-workers") {
    const allWorkers = await db
      .select()
      .from(workers)
      .where(eq(workers.guestId, guestId));

    const candidates = allWorkers
      .map((w) => ({ worker: w, state: workerStore.get(w.id) }))
      .filter(({ state }) => state?.online)
      .sort((a, b) => (a.state?.currentTask ? 1 : 0) - (b.state?.currentTask ? 1 : 0));
    return candidates.length > 0 ? candidates[0].worker.id : null;
  }
  if (location.startsWith("worker-")) {
    return location.replace("worker-", "");
  }
  return null;
}

/**
 * Atomically claim a pending torrent download.
 * See claimDownload in downloads.ts for full explanation.
 */
export async function claimTorrentDownload(
  id: string
): Promise<{ success: boolean; data?: typeof fileDownloads.$inferSelect }> {
  try {
    const guestId = await getGuestId();
    if (!guestId) return { success: false };

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

    if (!claimed) return { success: false };
    return { success: true, data: claimed };
  } catch {
    return { success: false };
  }
}

export async function createTorrentDownload(
  magnetLink: string,
  location: string,
  fileIndices: number[],
  meta: { fileName: string; fileSize: number; fileType: string }
) {
  try {
    const guestId = await getGuestId();
    if (!guestId) return { success: false, message: "Unauthorized" };
    const workerId = await resolveWorkerForTorrent(location, guestId);

    const [record] = await db.insert(fileDownloads).values({
      guestId: guestId ?? undefined,
      sourceUrl: magnetLink,
      location,
      workerId,
      fileName: meta.fileName,
      fileSize: meta.fileSize,
      fileType: meta.fileType,
      status: "pending",
      downloadType: "torrent",
      selectedFileIndices: fileIndices.length > 0 ? JSON.stringify(fileIndices) : null,
    }).returning();

    revalidatePath("/torrents");
    return { success: true, data: record };
  } catch (error) {
    console.error("Failed to create torrent download:", error);
    return { success: false, message: "Failed to create torrent download" };
  }
}

export interface TorrentDeltaSyncResult {
  data: (typeof fileDownloads.$inferSelect)[];
  syncedAt: string;
}

export async function getTorrentDownloads(
  since?: string
): Promise<TorrentDeltaSyncResult> {
  try {
    const guestId = await getGuestId();
    if (!guestId) return { data: [], syncedAt: new Date().toISOString() };

    const syncedAt = new Date().toISOString();

    const conditions: ReturnType<typeof eq>[] = [
      eq(fileDownloads.downloadType, "torrent"),
      eq(fileDownloads.guestId, guestId),
    ];

    if (since) {
      const { gte } = await import("drizzle-orm");
      conditions.push(gte(fileDownloads.updatedAt, new Date(since)));
    }

    const downloads = await db
      .select()
      .from(fileDownloads)
      .where(and(...conditions))
      .orderBy(desc(fileDownloads.createdAt));

    return { data: downloads, syncedAt };
  } catch (error) {
    console.error("Failed to fetch torrent downloads:", error);
    return { data: [], syncedAt: new Date().toISOString() };
  }
}

export async function deleteTorrentDownload(id: string) {
  try {
    const guestId = await getGuestId();
    if (!guestId) return { success: false, message: "Unauthorized" };

    const [download] = await db
      .select()
      .from(fileDownloads)
      .where(and(eq(fileDownloads.id, id), eq(fileDownloads.guestId, guestId)))
      .limit(1);

    if (!download) {
      return { success: false, message: "Download not found" };
    }

    if (download.status === "downloading") {
      return { success: false, message: "Cannot delete a download in progress" };
    }

    await db.delete(fileDownloads).where(eq(fileDownloads.id, id));

    revalidatePath("/torrents");
    return { success: true };
  } catch (error) {
    console.error("Failed to delete torrent download:", error);
    return { success: false, message: "Failed to delete torrent download" };
  }
}

export async function updateTorrentDownload(
  id: string,
  data: {
    sourceUrl?: string;
    fileName?: string;
    location?: "server" | "cloud" | "mega";
    status?: string;
    errorMessage?: string;
  }
) {
  try {
    const guestId = await getGuestId();
    if (!guestId) return { success: false, message: "Unauthorized" };

    const [download] = await db
      .select()
      .from(fileDownloads)
      .where(and(eq(fileDownloads.id, id), eq(fileDownloads.guestId, guestId)))
      .limit(1);

    if (!download) {
      return { success: false, message: "Download not found" };
    }

    // Allow marking as failed from any status
    const isFailed = data.status === "failed";
    if (!isFailed && download.status === "downloading" && (data.sourceUrl || data.location)) {
      return { success: false, message: "Cannot edit a download in progress" };
    }

    await db
      .update(fileDownloads)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(fileDownloads.id, id));

    revalidatePath("/torrents");
    return { success: true };
  } catch (error) {
    console.error("Failed to update torrent download:", error);
    return { success: false, message: "Failed to update torrent download" };
  }
}
