"use server";

import { db, fileDownloads } from "../db";
import { desc, eq } from "drizzle-orm";

export async function createDownload(sourceUrl: string, location: "server" | "mega", fileName?: string) {
  const [data] = await db.insert(fileDownloads).values({
    sourceUrl,
    location,
    fileName: fileName || "default",
    status: "pending",
  }).returning();
  
  return data;
}

export async function getDownloads() {
  const downloads = await db
    .select()
    .from(fileDownloads)
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

export async function updateDownload(id: string, data: { sourceUrl?: string; fileName?: string; location?: "server" | "mega" }) {
  // Check if download is still pending (reject if it started downloading)
  const [existing] = await db.select().from(fileDownloads).where(eq(fileDownloads.id, id));
  if (!existing) {
    return { success: false, message: "Download not found" };
  }
  if (existing.status !== "pending") {
    return { success: false, message: "Cannot edit a download that is no longer pending" };
  }
  
  const [updated] = await db.update(fileDownloads)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(fileDownloads.id, id))
    .returning();
  
  return { success: true, data: updated };
}
