"use server";

import { db, fileDownloads } from "../db";
import { eq, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function createTorrentDownload(
  magnetLink: string,
  location: "server" | "mega",
  fileName?: string,
  fileIndices?: number[]
) {
  try {
    await db.insert(fileDownloads).values({
      sourceUrl: magnetLink,
      location,
      fileName: fileName || null,
      status: "pending",
      downloadType: "torrent",
      selectedFileIndices: fileIndices ? JSON.stringify(fileIndices) : null,
    });

    revalidatePath("/torrents");
    return { success: true, fileIndices };
  } catch (error) {
    console.error("Failed to create torrent download:", error);
    return { success: false, message: "Failed to create torrent download" };
  }
}

export async function getTorrentDownloads() {
  try {
    const downloads = await db
      .select()
      .from(fileDownloads)
      .where(eq(fileDownloads.downloadType, "torrent"))
      .orderBy(desc(fileDownloads.createdAt));

    return downloads;
  } catch (error) {
    console.error("Failed to fetch torrent downloads:", error);
    return [];
  }
}

export async function deleteTorrentDownload(id: string) {
  try {
    const [download] = await db
      .select()
      .from(fileDownloads)
      .where(eq(fileDownloads.id, id))
      .limit(1);

    if (!download) {
      return { success: false, message: "Download not found" };
    }

    if (download.status === "downloading") {
      return {
        success: false,
        message: "Cannot delete a download in progress",
      };
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
    location?: "server" | "mega";
    status?: string;
    errorMessage?: string;
  }
) {
  try {
    const [download] = await db
      .select()
      .from(fileDownloads)
      .where(eq(fileDownloads.id, id))
      .limit(1);

    if (!download) {
      return { success: false, message: "Download not found" };
    }

    if (download.status === "downloading" && (data.sourceUrl || data.location)) {
      return {
        success: false,
        message: "Cannot edit a download in progress",
      };
    }

    await db
      .update(fileDownloads)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(fileDownloads.id, id));

    revalidatePath("/torrents");
    return { success: true };
  } catch (error) {
    console.error("Failed to update torrent download:", error);
    return { success: false, message: "Failed to update torrent download" };
  }
}
