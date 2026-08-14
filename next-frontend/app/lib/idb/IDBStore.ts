/**
 * Typed read/write helpers over the StreamLift IndexedDB.
 *
 * All methods are safe to call — they return empty results rather than
 * throwing if IDB is unavailable (e.g. SSR context, private-browsing quirks).
 */

import { getDB, type IDBFileDownload, type IDBWorker, type SyncMetaKey } from "./schema";
import type { FileDownload, Worker } from "@/app/db/schema";

// ─── Serialisation helpers ────────────────────────────────────────────────────

function toISOSafe(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  return d;
}

export function fileDownloadToIDB(row: FileDownload): IDBFileDownload {
  return {
    ...row,
    createdAt: toISOSafe(row.createdAt),
    updatedAt: toISOSafe(row.updatedAt),
    _syncedAt: new Date().toISOString(),
  };
}

export function workerToIDB(
  row: Worker,
  runtime?: { online: boolean; lastHeartbeat: string | null; pinggyUrl?: string | null; ipAddress?: string | null }
): IDBWorker {
  return {
    ...(row as any),
    createdAt:     toISOSafe(row.createdAt),
    updatedAt:     toISOSafe(row.updatedAt),
    _syncedAt:     new Date().toISOString(),
    online:        runtime?.online        ?? false,
    ipAddress:     (runtime?.ipAddress    ?? null) as any,
    lastHeartbeat: (runtime?.lastHeartbeat ?? null) as any,
  } as IDBWorker;
}

// ─── fileDownloads ────────────────────────────────────────────────────────────

export async function getAllDownloads(
  downloadType: "http" | "torrent"
): Promise<IDBFileDownload[]> {
  try {
    const db = await getDB();
    const all = await db.getAllFromIndex("fileDownloads", "by_downloadType", downloadType);
    // Sort newest-first (mirrors the server action ORDER BY createdAt DESC)
    return all.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  } catch {
    return [];
  }
}

export async function upsertDownloads(rows: FileDownload[]): Promise<void> {
  if (!rows.length) return;
  try {
    const db = await getDB();
    const tx = db.transaction("fileDownloads", "readwrite");
    await Promise.all(rows.map((r) => tx.store.put(fileDownloadToIDB(r))));
    await tx.done;
  } catch {
    // swallow — IDB write failures are non-fatal
  }
}

export async function deleteDownloadFromIDB(id: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete("fileDownloads", id);
  } catch {}
}

// ─── workers ──────────────────────────────────────────────────────────────────

export async function getAllWorkers(): Promise<IDBWorker[]> {
  try {
    const db = await getDB();
    const all = await db.getAll("workers");
    return all.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  } catch {
    return [];
  }
}

export async function upsertWorkers(
  rows: Worker[],
  runtimeStatus?: Record<string, { online: boolean; lastHeartbeat: string | null; pinggyUrl?: string | null; ipAddress?: string | null }>
): Promise<void> {
  if (!rows.length) return;
  try {
    const db = await getDB();
    const tx = db.transaction("workers", "readwrite");
    await Promise.all(
      rows.map((r) => tx.store.put(workerToIDB(r, runtimeStatus?.[r.id])))
    );
    await tx.done;
  } catch {}
}

/**
 * Patch only the runtime fields (online, lastHeartbeat) for workers that
 * already exist in IDB — used after a runtimeStatus-only update where no
 * DB rows changed. ipAddress is no longer tracked server-side.
 */
export async function patchWorkersRuntime(
  runtimeStatus: Record<string, { online: boolean; lastHeartbeat: string | null; pinggyUrl?: string | null; ipAddress?: string | null }>
): Promise<void> {
  const ids = Object.keys(runtimeStatus);
  if (!ids.length) return;
  try {
    const db = await getDB();
    const tx = db.transaction("workers", "readwrite");
    await Promise.all(
      ids.map(async (id) => {
        const existing = await tx.store.get(id);
        if (!existing) return;
        const live = runtimeStatus[id];
        await tx.store.put({
          ...existing,
          online:        live.online,
          ipAddress:     (live.ipAddress     ?? existing.ipAddress ?? null) as any,
          lastHeartbeat: (live.lastHeartbeat ?? null) as any,
          _syncedAt:     new Date().toISOString(),
        } as any);
      })
    );
    await tx.done;
  } catch {}
}

export async function deleteWorkerFromIDB(id: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete("workers", id);
  } catch {}
}

// ─── syncMeta ─────────────────────────────────────────────────────────────────

export async function getCursor(key: SyncMetaKey): Promise<string | undefined> {
  try {
    const db = await getDB();
    return await db.get("syncMeta", key);
  } catch {
    return undefined;
  }
}

export async function setCursor(key: SyncMetaKey, value: string): Promise<void> {
  try {
    const db = await getDB();
    await db.put("syncMeta", value, key);
  } catch {}
}

// ─── Full cache clear (guest rotation) ───────────────────────────────────────

export async function clearAllIDB(): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(["fileDownloads", "workers", "syncMeta"], "readwrite");
    await Promise.all([
      tx.objectStore("fileDownloads").clear(),
      tx.objectStore("workers").clear(),
      tx.objectStore("syncMeta").clear(),
    ]);
    await tx.done;
  } catch {}
}

// ─── Reconciliation — remove IDB rows not present on server ──────────────────

/**
 * Given the current set of server-side IDs for a download type,
 * remove any IDB rows whose IDs are not in that set.
 * Returns the number of rows removed.
 */
export async function reconcileDownloads(
  downloadType: "http" | "torrent",
  serverIds: string[]
): Promise<number> {
  try {
    const db = await getDB();
    const serverIdSet = new Set(serverIds);
    const idbRows = await db.getAllFromIndex("fileDownloads", "by_downloadType", downloadType);
    const orphans = idbRows.filter((r) => !serverIdSet.has(r.id));
    if (orphans.length === 0) return 0;
    const tx = db.transaction("fileDownloads", "readwrite");
    await Promise.all(orphans.map((r) => tx.store.delete(r.id)));
    await tx.done;
    return orphans.length;
  } catch {
    return 0;
  }
}

/**
 * Given the current set of server-side worker IDs,
 * remove any IDB worker rows not in that set.
 */
export async function reconcileWorkers(serverIds: string[]): Promise<number> {
  try {
    const db = await getDB();
    const serverIdSet = new Set(serverIds);
    const idbRows = await db.getAll("workers");
    const orphans = idbRows.filter((r) => !serverIdSet.has(r.id));
    if (orphans.length === 0) return 0;
    const tx = db.transaction("workers", "readwrite");
    await Promise.all(orphans.map((r) => tx.store.delete(r.id)));
    await tx.done;
    return orphans.length;
  } catch {
    return 0;
  }
}
