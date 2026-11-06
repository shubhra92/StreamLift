"use server";

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { fileDownloads, watchItems } from "../db/schema";
import { getWorkspaceId } from "../lib/getWorkspaceId";
import { getMediaKind, getMediaMime, isNativePlayable } from "../lib/media";
import type { WatchItemDto } from "../lib/watchTypes";

const MEGA_LOAD_TIMEOUT_MS = 8_000;
const MEGA_USER_AGENT = "StreamLift (+https://streamlift.app)";

function toDto(row: typeof watchItems.$inferSelect): WatchItemDto {
  return {
    id: row.id,
    provider: row.provider,
    providerItemId: row.providerItemId,
    name: row.name,
    fileSize: row.fileSize,
    kind: row.kind === "audio" ? "audio" : "video",
    mimeType: row.mimeType,
    sourceUrl: row.sourceUrl,
    playbackMode: row.playbackMode,
    sourceDownloadId: row.sourceDownloadId,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
  };
}

/**
 * Read the real file name/size from a public MEGA share link.
 *
 * The download row's fileName can be a torrent name (multi-file torrents) or
 * "default", so the share link is the authoritative source for what the Watch
 * item will actually play.
 */
async function readMegaMetadata(shareUrl: string): Promise<{ name: string; size: number | null }> {
  const { File: MegaFile } = await import("megajs");
  const file = MegaFile.fromURL(shareUrl);
  file.api.userAgent = MEGA_USER_AGENT;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      file.loadAttributes(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out reading the cloud file")),
          MEGA_LOAD_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!file.name) throw new Error("Cloud file has no name");
  return { name: file.name, size: typeof file.size === "number" ? file.size : null };
}

/** All saved Watch items for the current workspace, newest first. */
export async function getWatchItems(): Promise<WatchItemDto[]> {
  const workspaceId = await getWorkspaceId();
  if (!workspaceId) return [];

  const rows = await db
    .select()
    .from(watchItems)
    .where(eq(watchItems.workspaceId, workspaceId))
    .orderBy(desc(watchItems.createdAt));

  return rows.map(toDto);
}

export interface AddWatchItemResult {
  success: boolean;
  message?: string;
  item?: WatchItemDto;
  alreadyAdded?: boolean;
}

/**
 * Save a completed cloud download to the Watch page.
 *
 * The item is standalone: it copies the share URL and metadata so later
 * deletion of the download row does not affect playback.
 */
export async function addWatchItem(downloadId: string): Promise<AddWatchItemResult> {
  const workspaceId = await getWorkspaceId();
  if (!workspaceId) return { success: false, message: "Unauthorized" };

  const [download] = await db
    .select()
    .from(fileDownloads)
    .where(and(eq(fileDownloads.id, downloadId), eq(fileDownloads.workspaceId, workspaceId)))
    .limit(1);

  if (!download) return { success: false, message: "Download not found" };
  if (download.status !== "completed") {
    return { success: false, message: "Only completed downloads can be added to Watch" };
  }
  if (!download.cloudShareUrl) {
    return { success: false, message: "Create a share link first" };
  }

  // Idempotent: adding the same download twice returns the existing item.
  const [existingByDownload] = await db
    .select()
    .from(watchItems)
    .where(
      and(
        eq(watchItems.workspaceId, workspaceId),
        eq(watchItems.sourceDownloadId, download.id),
      ),
    )
    .limit(1);

  if (existingByDownload) {
    return { success: true, item: toDto(existingByDownload), alreadyAdded: true };
  }

  const provider = "mega";
  const playbackMode = "mega-share";

  const [existingBySource] = await db
    .select()
    .from(watchItems)
    .where(
      and(
        eq(watchItems.workspaceId, workspaceId),
        eq(watchItems.provider, provider),
        eq(watchItems.sourceUrl, download.cloudShareUrl),
      ),
    )
    .limit(1);

  if (existingBySource) {
    return { success: true, item: toDto(existingBySource), alreadyAdded: true };
  }

  let metadata: { name: string; size: number | null };
  try {
    metadata = await readMegaMetadata(download.cloudShareUrl);
  } catch {
    return {
      success: false,
      message:
        "Could not read this file from cloud storage. The share link may be stale — try creating it again.",
    };
  }

  const kind = getMediaKind(metadata.name);
  if (!kind || !isNativePlayable(metadata.name)) {
    return {
      success: false,
      message:
        "This file format is not browser-playable. Cloud Watch supports MP4/M4V/WebM/MOV/OGV and common audio formats.",
    };
  }

  const [inserted] = await db
    .insert(watchItems)
    .values({
      workspaceId,
      provider,
      providerItemId: download.cloudFileHandle ?? null,
      name: metadata.name,
      fileSize: metadata.size ?? download.fileSize ?? null,
      kind,
      mimeType: getMediaMime(metadata.name),
      sourceUrl: download.cloudShareUrl,
      playbackMode,
      sourceDownloadId: download.id,
    })
    .returning();

  return { success: true, item: toDto(inserted) };
}

/** Remove a Watch item. The cloud file and share link are left untouched. */
export async function deleteWatchItem(id: string): Promise<{ success: boolean; message?: string }> {
  const workspaceId = await getWorkspaceId();
  if (!workspaceId) return { success: false, message: "Unauthorized" };

  const deleted = await db
    .delete(watchItems)
    .where(and(eq(watchItems.id, id), eq(watchItems.workspaceId, workspaceId)))
    .returning({ id: watchItems.id });

  if (deleted.length === 0) return { success: false, message: "Watch item not found" };
  return { success: true };
}
