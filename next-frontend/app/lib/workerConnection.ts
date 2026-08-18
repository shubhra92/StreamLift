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

export interface WorkerLocalFile {
  index: number;
  name: string;
  size: number;
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
        // Required for Pinggy Free: bypasses its browser screening page.
        "X-Pinggy-No-Screen": "1",
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

/** Return completed local files that the worker still has for each download. */
export async function getWorkerLocalFiles(
  workerId: string,
  downloadIds: string[],
): Promise<Record<string, WorkerLocalFile[]>> {
  const res = await callWorker(workerId, "POST", "/downloads/files", { downloadIds });
  if (!res.ok) {
    throw new Error(`Worker file availability check failed (${res.status})`);
  }
  const data = await res.json();
  return data.filesByDownload ?? {};
}

/** Download a completed local worker file directly to the user's device. */
export async function downloadWorkerLocalFile(
  workerId: string,
  downloadId: string,
  file: WorkerLocalFile,
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void,
): Promise<void> {
  // The picker must happen before a transfer exists. Cancelling it therefore
  // creates no progress state and makes no request to the worker.
  const picker = (window as any).showSaveFilePicker;
  const handle = typeof picker === "function"
    ? await picker({ suggestedName: file.name })
    : null;

  const res = await callWorker(
    workerId,
    "GET",
    `/downloads/${encodeURIComponent(downloadId)}/files/${file.index}`,
  );
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail ?? "This file is no longer available on the worker");
  }

  const totalBytes = Number(res.headers.get("Content-Length")) || file.size || null;
  onProgress?.(0, totalBytes);
  // Chromium browsers can write a response stream straight to the selected
  // destination. Reading it ourselves lets StreamLift show real progress.
  if (handle) {
    const writable = await handle.createWritable();
    const reader = res.body.getReader();
    let receivedBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        receivedBytes += value.byteLength;
        onProgress?.(receivedBytes, totalBytes);
      }
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    return;
  }

  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value.slice().buffer);
    receivedBytes += value.byteLength;
    onProgress?.(receivedBytes, totalBytes);
  }
  const blob = new Blob(chunks);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Open an SSE connection to the worker's /stream endpoint.
 * Returns an object with a .close() method.
 * Uses fetch rather than EventSource so Pinggy's screening-bypass header can
 * be sent from a browser. Automatically retries after transient errors.
 */
export async function openWorkerStream(
  workerId: string,
  onMessage: (data: object) => void,
  onError?: (err: string) => void,
): Promise<{ close: () => void }> {
  let abortController: AbortController | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRetry = (message: string, delay: number) => {
    if (closed) return;
    invalidateWorkerConnection(workerId);
    onError?.(message);
    retryTimer = setTimeout(() => { void connect(); }, delay);
  };

  const connect = async () => {
    if (closed) return;

    let conn: WorkerConnection;
    try {
      conn = await getConnection(workerId);
    } catch (e: any) {
      scheduleRetry(`Cannot reach worker: ${e.message}`, 10_000);
      return;
    }

    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;

    try {
      const response = await fetch(`${conn.pinggyUrl}/stream`, {
        headers: {
          "Accept":              "text/event-stream",
          "X-Session-Token":     conn.sessionToken,
          "X-Pinggy-No-Screen": "1",
        },
        signal: controller.signal,
      });

      if (response.status === 401) {
        await refreshToken(workerId);
        scheduleRetry("Worker session expired — reconnecting…", 0);
        return;
      }

      if (!response.ok || !response.body) {
        throw new Error(`Worker stream failed (${response.status})`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        throw new Error("Worker stream returned a non-SSE response");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";

        for (const event of events) {
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          try { onMessage(JSON.parse(data)); }
          catch { /* Ignore malformed SSE payloads. */ }
        }
      }

      if (!closed) scheduleRetry("Worker stream disconnected — retrying…", 5_000);
    } catch (e: any) {
      if (closed || e?.name === "AbortError") return;
      scheduleRetry(`Worker stream error: ${e?.message ?? "unknown error"}`, 5_000);
    }
  };

  await connect();

  return {
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      abortController?.abort();
      abortController = null;
    },
  };
}

/** Invalidate cached connection (call when worker goes offline). */
export function invalidateWorkerConnection(workerId: string): void {
  _cache.delete(workerId);
}

/**
 * Start a native browser download through a worker-owned, file-only ticket.
 * The ticket exists only in the Python worker's memory; neither the URL nor
 * token is persisted by Next.js or in the database.
 */
export async function openWorkerLocalFileInBrowser(
  workerId: string,
  downloadId: string,
  file: WorkerLocalFile,
): Promise<void> {
  // Must be synchronous with the user's click or browsers will block the tab.
  const browserTab = window.open("about:blank", "_blank");
  if (!browserTab) {
    throw new Error("Your browser blocked the download tab. Allow popups for StreamLift and try again.");
  }

  try {
    browserTab.document.title = "Preparing download…";

    const res = await callWorker(
      workerId,
      "POST",
      `/downloads/${encodeURIComponent(downloadId)}/files/${file.index}/browser-link`,
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail ?? "This file is no longer available on the worker");
    }

    const data = await res.json() as { startPath?: string };
    if (!data.startPath?.startsWith("/")) {
      throw new Error("Worker did not return a valid browser download link");
    }

    // Read after callWorker in case it refreshed the cached worker session.
    const conn = await getConnection(workerId);
    console.log(`${"http"+conn.pinggyUrl.slice(5)}${data.startPath}`)
    // browserTab.location.replace(`${"http"+conn.pinggyUrl.slice(5)}${data.startPath}`);
    browserTab.location.href = `${"http"+conn.pinggyUrl.slice(5)}${data.startPath}`
    // window.location.href = `${"http"+conn.pinggyUrl.slice(5)}${data.startPath}`
  } catch (error) {
    browserTab.close();
    throw error;
  }
}