/**
 * Client-side helper for direct worker API calls.
 *
 * Handles:
 * - Fetching + caching { pinggyUrl, sessionToken } per worker
 * - Auto-refresh on 401 (token expired mid-session)
 * - Typed wrappers for trigger-download and cancel
 */

import type { WorkerFileTransferPart } from "./sync-worker/workerProtocol";

const ENV = {
  "NEXT_PUBLIC_MAX_PARALLEL_PARTS": process.env.NEXT_PUBLIC_MAX_PARALLEL_PARTS,
  "NEXT_PUBLIC_MIN_PART_SIZE_MB": process.env.NEXT_PUBLIC_MIN_PART_SIZE_MB
} as const

/** Read a positive integer from an env var, falling back to `fallback`. */
function envInt(name: keyof typeof ENV, fallback: number): number {
  let raw = ENV[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Parallel download tuning. Free tunnel services usually throttle bandwidth
// per connection, so several concurrent Range streams can outperform one.
// Configurable via .env.local (NEXT_PUBLIC_ prefix — these are client-visible):
//   NEXT_PUBLIC_MAX_PARALLEL_PARTS=6      — concurrent stream connections
//   NEXT_PUBLIC_MIN_PART_SIZE_MB=10       — files smaller than this stay single-stream
const MAX_PARALLEL_PARTS = envInt("NEXT_PUBLIC_MAX_PARALLEL_PARTS", 4);
const MIN_PART_SIZE = envInt("NEXT_PUBLIC_MIN_PART_SIZE_MB", 5) * 1024 * 1024;
const PART_MAX_ATTEMPTS = 4;           // per part, incl. mid-stream resume attempts
const PART_RETRY_DELAY_MS = 800;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Server answered 200 to a Range request — it ignored the header entirely. */
class RangeNotSupportedError extends Error {}

/**
 * Maximum number of parallel parts allowed for a file of this size:
 * bounded by NEXT_PUBLIC_MAX_PARALLEL_PARTS and by NEXT_PUBLIC_MIN_PART_SIZE_MB
 * (each part must be at least that big). Returns 1 when splitting is pointless.
 */
export function getMaxPartsForSize(totalBytes: number): number {
  if (totalBytes <= 0) return 1;
  const byMinSize = Math.floor(totalBytes / MIN_PART_SIZE);
  return Math.max(1, Math.min(MAX_PARALLEL_PARTS, byMinSize));
}

/** True when a file of this size can be split into multiple parallel parts. */
export function isMultiPartPossible(totalBytes: number): boolean {
  return getMaxPartsForSize(totalBytes) > 1;
}

/** Split a file into equal, contiguous byte ranges. */
function buildParts(totalBytes: number, requestedParts: number): WorkerFileTransferPart[] {
  if (totalBytes <= 0) return [];
  const partCount = Math.min(Math.max(1, requestedParts), getMaxPartsForSize(totalBytes));
  if (partCount <= 1) {
    return [{ index: 0, start: 0, end: totalBytes - 1, receivedBytes: 0, status: "pending" }];
  }
  const parts: WorkerFileTransferPart[] = [];
  const partSize = Math.ceil(totalBytes / partCount);
  for (let i = 0; i < partCount; i++) {
    const start = i * partSize;
    if (start >= totalBytes) break;
    parts.push({
      index: i,
      start,
      end: Math.min(start + partSize - 1, totalBytes - 1),
      receivedBytes: 0,
      status: "pending",
    });
  }
  return parts;
}

/**
 * Single-stream download with mid-stream resume.
 * Range queries are sent as ?range=bytes=N- (query strings always survive
 * proxies); a break mid-stream resumes from the last received byte.
 */
async function writeResponseStream(
  workerId: string,
  filePath: string,
  handle: any,
  file: WorkerLocalFile,
  fallbackTotalBytes: number,
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void,
): Promise<void> {
  const totalBytes = fallbackTotalBytes || null;
  let received = 0;
  let writable: any = null;
  const chunks: BlobPart[] = [];

  for (let attempt = 1; attempt <= PART_MAX_ATTEMPTS; attempt++) {
    const resumePath = received > 0 ? `${filePath}?range=bytes=${received}-` : filePath;

    let res: Response;
    try {
      res = await callWorker(workerId, "GET", resumePath);
    } catch (error: any) {
      if (error?.name === "AbortError") throw error;
      console.warn(`[workerConnection] single-stream fetch failed (attempt ${attempt}/${PART_MAX_ATTEMPTS}):`, error?.message ?? error);
      if (attempt === PART_MAX_ATTEMPTS) throw error;
      await sleep(PART_RETRY_DELAY_MS * attempt);
      continue;
    }
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail ?? "This file is no longer available on the worker");
    }
    if (received > 0 && res.status !== 206) {
      throw new Error("Worker cannot resume an interrupted download");
    }

    if (!writable && handle) {
      writable = await handle.createWritable();
    }
    onProgress?.(received, totalBytes);

    const reader = res.body.getReader();
    let streamError: unknown = null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (writable) {
          await writable.write({ type: "write", position: received, data: value });
        } else {
          chunks.push(value.slice().buffer);
        }
        received += value.byteLength;
        onProgress?.(received, totalBytes);
      }
    } catch (error: any) {
      if (error?.name === "AbortError") throw error;
      streamError = error;
    }
    if (streamError) {
      console.warn(`[workerConnection] single-stream broke at ${received} bytes (attempt ${attempt}/${PART_MAX_ATTEMPTS}):`, (streamError as any)?.message ?? streamError);
      if (attempt === PART_MAX_ATTEMPTS) {
        if (writable) await writable.abort().catch(() => undefined);
        throw streamError;
      }
      await sleep(PART_RETRY_DELAY_MS * attempt);
      continue;
    }
    break;
  }

  if (writable) {
    await writable.close();
  } else {
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
}

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

// Shared in-flight refresh — concurrent 401s (e.g. parallel parts) must share
// ONE token rotation. Each rotation invalidates the previous token, so parallel
// refreshes would otherwise produce stale tokens for all but one caller.
let refreshInFlight: Promise<WorkerConnection> | null = null;

/** Refresh the session token and update cache. Serialised across callers. */
async function refreshToken(workerId: string): Promise<WorkerConnection> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefreshToken(workerId).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function doRefreshToken(workerId: string): Promise<WorkerConnection> {
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
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
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
        ...extraHeaders,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
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

/**
 * Download a completed local worker file directly to the user's device.
 *
 * Larger files are split into parallel byte ranges — each part uses its own
 * stream connection to the worker (free tunnel bandwidth is throttled per
 * connection, so parallel streams are faster). If the worker does not honour
 * Range requests, the download transparently falls back to a single stream.
 */
export async function downloadWorkerLocalFile(
  workerId: string,
  downloadId: string,
  file: WorkerLocalFile,
  onProgress?: (receivedBytes: number, totalBytes: number | null, parts?: WorkerFileTransferPart[]) => void,
  requestedParts?: number,
): Promise<void> {
  // The picker must happen before a transfer exists. Cancelling it therefore
  // creates no progress state and makes no request to the worker.
  const picker = (window as any).showSaveFilePicker;
  const handle = typeof picker === "function"
    ? await picker({ suggestedName: file.name })
    : null;

  const totalBytes = file.size || 0;
  const parts = buildParts(totalBytes, requestedParts ?? MAX_PARALLEL_PARTS);
  const filePath = `/downloads/${encodeURIComponent(downloadId)}/files/${file.index}`;

  // Single stream — no range needed (small files, unknown size)
  if (parts.length <= 1) {
    await writeResponseStream(workerId, filePath, handle, file, totalBytes, onProgress);
    return;
  }

  // ── Parallel multi-part download ─────────────────────────────────────────
  const controller = new AbortController();
  let writable: any = null;
  const blobParts = new Map<number, ArrayBuffer[]>();
  let totalReceived = 0;

  const reportProgress = () => onProgress?.(totalReceived, totalBytes, parts);

  const writeChunk = (part: WorkerFileTransferPart, chunk: Uint8Array) => {
    if (writable) {
      return writable.write({ type: "write", position: part.start + part.receivedBytes, data: chunk });
    }
    const buffers = blobParts.get(part.index) ?? [];
    buffers.push(chunk.slice().buffer);
    blobParts.set(part.index, buffers);
    return Promise.resolve();
  };

  /**
   * Download one part with mid-stream resume: if the stream breaks partway
   * (common with flaky tunnels), the part retries from its current offset
   * instead of failing — already-written bytes are never re-fetched.
   */
  const downloadPart = async (part: WorkerFileTransferPart): Promise<void> => {
    part.status = "downloading";
    reportProgress();

    for (let attempt = 1; attempt <= PART_MAX_ATTEMPTS; attempt++) {
      const startOffset = part.start + part.receivedBytes;
      if (startOffset > part.end) {
        part.status = "completed";
        reportProgress();
        return;
      }

      let res: Response;
      try {
        res = await callWorker(
          workerId,
          "GET",
          // Query-param range: query strings always survive proxies, unlike
          // Range headers which some tunnels strip. The Range header is still
          // sent as a bonus for servers that understand it.
          `${filePath}?range=bytes=${startOffset}-${part.end}`,
          undefined,
          { Range: `bytes=${startOffset}-${part.end}` },
          controller.signal,
        );
      } catch (error: any) {
        if (error?.name === "AbortError") throw error;
        console.warn(`[workerConnection] part ${part.index + 1} fetch failed (attempt ${attempt}/${PART_MAX_ATTEMPTS}):`, error?.message ?? error);
        if (attempt === PART_MAX_ATTEMPTS) throw error;
        await sleep(PART_RETRY_DELAY_MS * attempt);
        continue;
      }

      // 200 = server ignored our range — parallel download not possible
      if (res.status === 200) {
        const contentType = res.headers.get("Content-Type") ?? "";
        if (contentType.includes("text/html")) {
          // Tunnel served an interstitial page instead of the file
          console.warn(`[workerConnection] part ${part.index + 1} got an HTML screen (attempt ${attempt}/${PART_MAX_ATTEMPTS})`);
          if (attempt === PART_MAX_ATTEMPTS) throw new Error("Tunnel served an interstitial page instead of the file");
          await sleep(PART_RETRY_DELAY_MS * attempt);
          continue;
        }
        throw new RangeNotSupportedError();
      }
      if (res.status !== 206 || !res.body) {
        const err = await res.json().catch(() => ({}));
        const message = err.detail ?? `Part ${part.index + 1} failed (${res.status})`;
        console.warn(`[workerConnection] part ${part.index + 1} bad response (attempt ${attempt}/${PART_MAX_ATTEMPTS}): ${res.status}`);
        if (attempt === PART_MAX_ATTEMPTS) throw new Error(message);
        await sleep(PART_RETRY_DELAY_MS * attempt);
        continue;
      }

      // Verify the server actually returned the exact range we asked for.
      // Content-Range can be hidden from the browser by CORS on some
      // workers/proxies — in that case fall back to Content-Length matching.
      const contentRange = res.headers.get("Content-Range");
      const match = contentRange?.match(/^bytes\s+(\d+)-(\d+)\/\d+$/);
      const expectedLength = part.end - startOffset + 1;
      const contentLength = Number(res.headers.get("Content-Length"));
      const rangeMatches =
        (match && Number(match[1]) === startOffset && Number(match[2]) === part.end) ||
        (contentRange === null && contentLength === expectedLength);
      if (!rangeMatches) {
        console.warn(`[workerConnection] part ${part.index + 1} unexpected Content-Range:`, contentRange, `Content-Length: ${contentLength}`);
        throw new RangeNotSupportedError();
      }

      // Read the stream; a break mid-stream resumes on the next attempt
      const reader = res.body.getReader();
      let streamError: unknown = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writeChunk(part, value);
          part.receivedBytes += value.byteLength;
          totalReceived += value.byteLength;
          reportProgress();
        }
      } catch (error: any) {
        if (error?.name === "AbortError") throw error;
        streamError = error;
      }
      if (streamError) {
        console.warn(`[workerConnection] part ${part.index + 1} stream broke at ${part.receivedBytes}/${part.end - part.start + 1} bytes (attempt ${attempt}/${PART_MAX_ATTEMPTS}):`, (streamError as any)?.message ?? streamError);
        if (attempt === PART_MAX_ATTEMPTS) throw streamError;
        await sleep(PART_RETRY_DELAY_MS * attempt);
        continue;
      }

      part.status = "completed";
      reportProgress();
      return;
    }
  };

  try {
    if (handle) {
      // keepExistingData: positional writes must not truncate the file
      writable = await handle.createWritable({ keepExistingData: true });
    }
    await Promise.all(parts.map(downloadPart));

    if (writable) {
      await writable.close();
    } else {
      const orderedBuffers = Array.from(blobParts.entries())
        .sort((a, b) => a[0] - b[0])
        .flatMap(([, buffers]) => buffers);
      const blob = new Blob(orderedBuffers);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    controller.abort();
    if (writable) await writable.abort().catch(() => undefined);
    console.warn("[workerConnection] parallel transfer failed:", error);

    // Worker doesn't support ranges — re-download as a single stream
    if (error instanceof RangeNotSupportedError) {
      console.warn("[workerConnection] worker does not support range queries — falling back to single stream");
      await writeResponseStream(workerId, filePath, handle, file, totalBytes, onProgress);
      return;
    }
    throw error;
  }
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