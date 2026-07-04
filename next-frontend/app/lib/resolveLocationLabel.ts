// Cache worker names so we don't fetch on every render
let workerNameCache: Map<string, string> | null = null;
let cacheExpiry = 0;

async function getWorkerNameCache(): Promise<Map<string, string>> {
  if (workerNameCache && Date.now() < cacheExpiry) return workerNameCache;

  try {
    const res = await fetch("/api/worker/list");
    if (!res.ok) return workerNameCache ?? new Map();
    const result = await res.json();
    const map = new Map<string, string>();
    for (const w of result.data ?? []) {
      map.set(w.id, w.name);
    }
    workerNameCache = map;
    cacheExpiry = Date.now() + 30_000; // cache for 30s
    return map;
  } catch {
    return workerNameCache ?? new Map();
  }
}

export async function resolveLocationLabel(location: string | null | undefined): Promise<string | null > {
  if (!location) return "—";
  if (location === "server") return "Cloud (Server)";
  if (location === "mega") return "Cloud";
  if (location === "all-workers") return "All Workers";

  if (location.startsWith("worker-")) {
    const workerId = location.replace("worker-", "");
    const cache = await getWorkerNameCache();
    const name = cache.get(workerId);
    return name ? `Worker: ${name}` :  null //`Worker: ${workerId.slice(0, 8)}…`;
  }

  return location;
}

/** Synchronous version using cached data only (for render-time use) */
export function resolveLocationLabelSync(location: string | null | undefined): string {
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

export function invalidateWorkerNameCache() {
  workerNameCache = null;
}
