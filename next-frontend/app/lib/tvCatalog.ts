import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { fileDownloads, workers } from "../db/schema";
import type { FileDownload, Worker } from "../db/schema";
import { isWorkerOnline } from "./workerPresence";
import { getMediaKind } from "./media";
import { isSessionTokenExpired, rotateSessionToken } from "./sessionToken";
import type { TvCatalogFile, TvCatalogGroup, TvCatalogPayload } from "./tvTypes";
import { getTunnelBypassHeaders } from "./tunnelHeaders";

const ID_BATCH_SIZE = 100;
const WORKER_FETCH_TIMEOUT_MS = 5_000;
const CATALOG_CACHE_TTL_MS = 10_000;

/**
 * A fixed capability string for thumbnails. Thumbnails do not need the TV's
 * exact playback capabilities; a stable value shares the workspace cache with
 * other clients instead of creating a new ffmpeg session per TV.
 */
const THUMBNAIL_CAPS = "h264|aac";

interface WorkerLocalFile {
  index: number;
  name: string;
  size: number;
}

interface WorkerConnection {
  baseUrl: string;
  sessionToken: string;
}

interface CacheEntry {
  at: number;
  data: TvCatalogPayload;
}

const catalogCache = new Map<string, CacheEntry>();

class WorkerHttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function getWorkerConnection(worker: Worker): Promise<WorkerConnection> {
  if (!worker.tunnelUrl) throw new Error("Worker tunnel is offline");

  const baseUrl = worker.tunnelUrl.replace(/\/+$/, "");
  let sessionToken = worker.sessionToken;

  if (!sessionToken || isSessionTokenExpired(worker.sessionTokenExpiry)) {
    sessionToken = await rotateSessionToken(worker.id, baseUrl, worker.authToken);
  }

  return { baseUrl, sessionToken };
}

async function readWorkerFiles(
  connection: WorkerConnection,
  downloadIds: string[],
): Promise<Record<string, WorkerLocalFile[]>> {
  const result: Record<string, WorkerLocalFile[]> = {};

  for (let offset = 0; offset < downloadIds.length; offset += ID_BATCH_SIZE) {
    const batch = downloadIds.slice(offset, offset + ID_BATCH_SIZE);
    const res = await fetch(`${connection.baseUrl}/downloads/files`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Token": connection.sessionToken,
        ...getTunnelBypassHeaders(connection.baseUrl),
      },
      body: JSON.stringify({ downloadIds: batch }),
      cache: "no-store",
      signal: AbortSignal.timeout(WORKER_FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new WorkerHttpError(`Worker file check failed (${res.status})`, res.status);
    }

    const data = (await res.json()) as { filesByDownload?: Record<string, WorkerLocalFile[]> };
    Object.assign(result, data.filesByDownload ?? {});
  }

  return result;
}

async function fetchWorkerFiles(
  worker: Worker,
  downloadIds: string[],
): Promise<Record<string, WorkerLocalFile[]>> {
  const connection = await getWorkerConnection(worker);

  try {
    return await readWorkerFiles(connection, downloadIds);
  } catch (error) {
    // The web or another TV may have rotated the shared worker token between
    // our DB read and the call. Refresh once and retry.
    if (error instanceof WorkerHttpError && error.status === 401) {
      const refreshed = await rotateSessionToken(worker.id, connection.baseUrl, worker.authToken);
      return readWorkerFiles({ ...connection, sessionToken: refreshed }, downloadIds);
    }
    throw error;
  }
}

function buildThumbnailUrl(baseUrl: string, downloadId: string, fileIndex: number): string {
  const caps = encodeURIComponent(THUMBNAIL_CAPS);
  return `${baseUrl}/downloads/${encodeURIComponent(downloadId)}/files/${fileIndex}/thumbnail?t=10&w=640&caps=${caps}`;
}

function displayDownloadName(download: FileDownload, file: WorkerLocalFile): string {
  const name = download.fileName?.trim();
  if (name && name !== "default") return name;
  return file.name;
}

/**
 * Build the exact content the web `/watch` page shows, but server-side:
 * online workers with local storage → completed downloads → files that still
 * exist on the worker → playable video/audio only.
 *
 * Media bytes never pass through this server; the catalog only contains
 * metadata and directly reachable worker thumbnail URLs.
 */
export async function buildTvCatalog(
  guestId: string,
  options: { force?: boolean } = {},
): Promise<TvCatalogPayload> {
  const cached = catalogCache.get(guestId);
  if (!options.force && cached && Date.now() - cached.at < CATALOG_CACHE_TTL_MS) {
    return cached.data;
  }

  const now = Date.now();
  const workerRows = await db
    .select()
    .from(workers)
    .where(and(eq(workers.guestId, guestId), eq(workers.downloadLocation, "local")));

  const onlineWorkers = workerRows.filter(
    (worker) =>
      Boolean(worker.tunnelUrl?.startsWith("https://")) &&
      isWorkerOnline(worker.lastHeartbeat, now),
  );

  const downloads = await db
    .select()
    .from(fileDownloads)
    .where(and(eq(fileDownloads.guestId, guestId), eq(fileDownloads.status, "completed")));

  const downloadsByWorker = new Map<string, FileDownload[]>();
  for (const download of downloads) {
    if (!download.workerId) continue;
    const list = downloadsByWorker.get(download.workerId);
    if (list) list.push(download);
    else downloadsByWorker.set(download.workerId, [download]);
  }

  const groups: TvCatalogGroup[] = [];
  const unreachableWorkers: TvCatalogPayload["unreachableWorkers"] = [];

  await Promise.all(
    onlineWorkers.map(async (worker) => {
      const workerDownloads = downloadsByWorker.get(worker.id) ?? [];
      if (workerDownloads.length === 0) return;

      try {
        const filesByDownload = await fetchWorkerFiles(
          worker,
          workerDownloads.map((download) => download.id),
        );

        const files: TvCatalogFile[] = [];
        const seen = new Set<string>();

        for (const download of workerDownloads) {
          for (const file of filesByDownload[download.id] ?? []) {
            const kind = getMediaKind(file.name);
            if (!kind) continue;

            const dedupeKey = `${file.name}:${file.size}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            files.push({
              key: `${worker.id}:${download.id}:${file.index}`,
              downloadId: download.id,
              fileIndex: file.index,
              name: file.name,
              downloadName: displayDownloadName(download, file),
              size: file.size,
              kind,
              addedAt:
                download.updatedAt?.toISOString() ??
                download.createdAt?.toISOString() ??
                null,
              thumbnailUrl: buildThumbnailUrl(
                worker.tunnelUrl!.replace(/\/+$/, ""),
                download.id,
                file.index,
              ),
            });
          }
        }

        if (files.length === 0) return;
        files.sort((a, b) => a.name.localeCompare(b.name));

        groups.push({
          worker: {
            id: worker.id,
            name: worker.name,
            countryCode: worker.countryCode,
            online: true,
            lastHeartbeat: worker.lastHeartbeat?.toISOString() ?? null,
          },
          files,
        });
      } catch (error) {
        unreachableWorkers.push({
          workerId: worker.id,
          name: worker.name,
          message: error instanceof Error ? error.message : "Worker is unreachable",
        });
      }
    }),
  );

  groups.sort((a, b) => a.worker.name.localeCompare(b.worker.name));

  const payload: TvCatalogPayload = {
    generatedAt: new Date().toISOString(),
    groups,
    unreachableWorkers,
    totals: {
      workers: groups.length,
      files: groups.reduce((total, group) => total + group.files.length, 0),
    },
  };

  catalogCache.set(guestId, { at: Date.now(), data: payload });
  return payload;
}

/** Used when a TV is disconnected so a later re-pair gets a fresh view. */
export function clearTvCatalogCache(guestId: string): void {
  catalogCache.delete(guestId);
}
