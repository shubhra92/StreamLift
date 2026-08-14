/**
 * Client-side helper for direct worker API calls.
 *
 * Handles:
 * - Fetching + caching { pinggyUrl, sessionToken } per worker
 * - Auto-refresh on 401 (token expired mid-session)
 * - Typed wrappers for trigger-download and cancel
 */

export interface WorkerConnection {
  pinggyUrl:    string;
  sessionToken: string;
}

export interface TriggerDownloadParams {
  downloadId:   string;
  sourceUrl:    string;
  fileName:     string;
  downloadType: "http" | "torrent";
  fileIndices?: number[] | null;
}

// Per-worker connection cache — keyed by workerId
const _cache = new Map<string, WorkerConnection>();

/** Fetch (or return cached) connection details for a worker. */
async function getConnection(workerId: string): Promise<WorkerConnection> {
  const cached = _cache.get(workerId);
  if (cached) return cached;

  const res = await fetch(`/api/worker/${workerId}/connection`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `Failed to get worker connection (${res.status})`);
  }
  const data = await res.json();
  const conn: WorkerConnection = {
    pinggyUrl:    data.pinggyUrl,
    sessionToken: data.sessionToken,
  };
  _cache.set(workerId, conn);
  return conn;
}

/** Refresh the session token and update cache. */
async function refreshToken(workerId: string): Promise<WorkerConnection> {
  _cache.delete(workerId);

  const res = await fetch(`/api/worker/${workerId}/refresh-token`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `Failed to refresh session token (${res.status})`);
  }
  const data = await res.json();

  // We need the pinggyUrl too — re-fetch the full connection
  const connRes = await fetch(`/api/worker/${workerId}/connection`);
  if (!connRes.ok) throw new Error("Failed to reload connection after token refresh");
  const connData = await connRes.json();
  const conn: WorkerConnection = {
    pinggyUrl:    connData.pinggyUrl,
    sessionToken: data.sessionToken,
  };
  _cache.set(workerId, conn);
  return conn;
}

/**
 * Call a worker endpoint with automatic 401 retry.
 * On first 401, refreshes the session token and retries once.
 */
async function callWorker(
  workerId: string,
  method: string,
  path: string,
  body?: object,
): Promise<Response> {
  let conn = await getConnection(workerId);

  const doFetch = (c: WorkerConnection) =>
    fetch(`${c.pinggyUrl}${path}`, {
      method,
      headers: {
        "Content-Type":    "application/json",
        "X-Session-Token": c.sessionToken,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  let res = await doFetch(conn);

  if (res.status === 401) {
    // Token expired — refresh once and retry
    conn = await refreshToken(workerId);
    res  = await doFetch(conn);
  }

  return res;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Trigger a download on the worker. */
export async function triggerWorkerDownload(
  workerId: string,
  params: TriggerDownloadParams,
): Promise<{ success: boolean; downloadId: string }> {
  const res = await callWorker(workerId, "POST", "/download", params);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail ?? `Worker download trigger failed (${res.status})`);
  }
  return res.json();
}

/** Cancel an in-progress download on the worker. */
export async function cancelWorkerDownload(
  workerId: string,
  downloadId: string,
): Promise<void> {
  const res = await callWorker(workerId, "DELETE", `/download/${downloadId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail ?? `Cancel failed (${res.status})`);
  }
}

/**
 * Open an SSE connection to the worker's /stream endpoint.
 * Returns an object with a .close() method.
 * Automatically retries after errors (token expiry, transient network issues).
 */
export async function openWorkerStream(
  workerId: string,
  onMessage: (data: object) => void,
  onError?: (err: string) => void,
): Promise<{ close: () => void }> {
  let es: EventSource | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = async () => {
    if (closed) return;

    let conn: WorkerConnection;
    try {
      conn = await getConnection(workerId);
    } catch (e: any) {
      onError?.(`Cannot reach worker: ${e.message}`);
      // Retry after 10s
      if (!closed) retryTimer = setTimeout(connect, 10_000);
      return;
    }

    // EventSource doesn't support custom headers — pass token as query param
    const url = `${conn.pinggyUrl}/stream?token=${encodeURIComponent(conn.sessionToken)}`;

    es = new EventSource(url);

    es.onmessage = (event) => {
      if (closed) return;
      try {
        onMessage(JSON.parse(event.data));
      } catch {
        // ignore malformed events
      }
    };

    es.onerror = () => {
      if (closed) return;
      es?.close();
      es = null;
      // Invalidate cached token so next connect gets a fresh one
      invalidateWorkerConnection(workerId);
      onError?.("Worker stream disconnected — retrying...");
      // Retry after 5s
      if (!closed) retryTimer = setTimeout(connect, 5_000);
    };
  };

  await connect();

  return {
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
      es = null;
    },
  };
}

/** Invalidate cached connection (call when worker goes offline). */
export function invalidateWorkerConnection(workerId: string): void {
  _cache.delete(workerId);
}
