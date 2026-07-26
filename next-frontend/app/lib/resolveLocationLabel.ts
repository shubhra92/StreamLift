/**
 * Resolves a location string to a human-readable label.
 *
 * For worker-{id} locations, looks up the worker name from IndexedDB
 * instead of making a network call — IDB is always up to date from
 * the SyncManager/SharedWorker sync.
 */

import { getAllWorkers } from "@/app/lib/idb/IDBStore";

// In-memory cache of workerId → name, populated from IDB
// This avoids repeated IDB reads on every render of every download row.
let workerNameCache: Map<string, string> | null = null;

/**
 * Populate the cache from IDB. IDB is the source of truth —
 * no network call needed.
 */
async function getWorkerNameCache(): Promise<Map<string, string>> {
  if (workerNameCache) return workerNameCache;

  try {
    const workers = await getAllWorkers();
    const map = new Map<string, string>();
    for (const w of workers) {
      map.set(w.id, w.name);
    }
    workerNameCache = map;
    return map;
  } catch {
    return workerNameCache ?? new Map();
  }
}

/** Invalidate the in-memory cache — call after workers are created/deleted */
export function invalidateWorkerNameCache(): void {
  workerNameCache = null;
}

export async function resolveLocationLabel(
  location: string | null | undefined
): Promise<string | null> {
  if (!location) return "—";
  if (location === "server") return "Cloud (Server)";
  if (location === "mega") return "Cloud";
  if (location === "all-workers") return "All Workers";

  if (location.startsWith("worker-")) {
    const workerId = location.replace("worker-", "");
    const cache = await getWorkerNameCache();
    const name = cache.get(workerId);
    return name ? `Worker: ${name}` : null;
  }

  return location;
}

/** Synchronous version using cached data only (for render-time use) */
export function resolveLocationLabelSync(
  location: string | null | undefined
): string {
  if (!location) return "—";
  if (location === "server") return "Cloud (Server)";
  if (location === "mega") return "Cloud";
  if (location === "all-workers") return "All Workers";

  if (location.startsWith("worker-")) {
    const workerId = location.replace("worker-", "");
    const name = workerNameCache?.get(workerId);
    return name ? `Worker: ${name}` : `Worker: ${workerId.slice(0, 8)}…`;
  }

  return location;
}
