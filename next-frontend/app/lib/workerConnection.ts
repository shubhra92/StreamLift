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
  "NEXT_PUBLIC_MIN_PART_SIZE_MB": process.env.NEXT_PUBLIC_MIN_PART_SIZE_MB,
  "NEXT_PUBLIC_SLOW_SPEED_KBS": process.env.NEXT_PUBLIC_SLOW_SPEED_KBS,
  "NEXT_PUBLIC_SLOW_WINDOW_SEC": process.env.NEXT_PUBLIC_SLOW_WINDOW_SEC,
  "NEXT_PUBLIC_STALL_TIMEOUT_SEC": process.env.NEXT_PUBLIC_STALL_TIMEOUT_SEC,
  "NEXT_PUBLIC_MAX_SLOW_RESTARTS": process.env.NEXT_PUBLIC_MAX_SLOW_RESTARTS,
} as const

/** Read a positive integer from an env var, falling back to `fallback`. */
function envInt(name: keyof typeof ENV, fallback: number): number {
  let raw = ENV[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Detect a MEGA bandwidth-limit (HTTP 509) error. We cannot rely on `err.timeLimit`
 * alone: MEGA often returns a null/empty `x-mega-time-left` header, so megajs sets
 * `error.timeLimit = null` even though the connection genuinely hit the 509 limit
 * ("Bandwidth limit reached: null seconds until it resets"). Match on the message
 * and/or status text instead.
 */
function isBandwidthLimitError(err: any): boolean {
  if (err?.timeLimit != null && err.timeLimit !== "" && err.timeLimit !== "null") return true;
  const msg = String(err?.message ?? "").toLowerCase();
  return msg.includes("bandwidth") || msg.includes("509");
}

/**
 * Raw MEGA pre-flight: test whether this share can be downloaded without relying
 * on megajs's internal chunk splitting. Request the WHOLE file range
 * (0..fileSize-1) in the URL path (the format MEGA's storage servers expect, as
 * megajs builds it), and abort as soon as the first byte of the real download
 * arrives. MEGA evaluates the requested range against the bandwidth/quota window,
 * so a 509 means the download is currently blocked. Resolves to the number of
 * seconds left if 509 (bandwidth limit reached), or null if authorized. Non-509
 * statuses and transport errors also resolve to null so a transient probe error
 * (or MEGA rejecting an oversized single range) never falsely blocks the save
 * picker.
 */
async function checkMegaQuota(shareUrl: string, fileSize: number): Promise<number | null> {
  try {
    const handle = shareUrl.match(/\/file\/([^#?]+)/)?.[1];
    if (!handle) return null;
    const apiRes = await fetch("https://g.api.mega.co.nz/cs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ a: "g", v: 2, g: 1, ssl: 1, p: handle }]),
    });
    if (!apiRes.ok) return null;
    const data = (await apiRes.json()) as { g?: string }[];
    const gUrl = data?.[0]?.g;
    if (!gUrl) return null;
    // Whole-file range appended to the URL path (0-<last byte>), mirroring how
    // megajs encodes byte ranges in the request URL. We abort as soon as any body
    // data arrives, so checking never pulls more than a few bytes.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const rangeEnd = Math.max(0, fileSize - 1);
      const res = await fetch(`${gUrl}/0-${rangeEnd}`, { signal: controller.signal });
      if (res.status === 509) {
        const timeLeft = res.headers.get("x-mega-time-left");
        const n = Number.parseInt(timeLeft ?? "", 10);
        return Number.isFinite(n) ? n : 0;
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

// Parallel download tuning. Free tunnel services usually throttle bandwidth
// per connection, so several concurrent Range streams can outperform one.
// Configurable via .env.local (NEXT_PUBLIC_ prefix — these are client-visible):
//   NEXT_PUBLIC_MAX_PARALLEL_PARTS=6       — concurrent stream connections
//   NEXT_PUBLIC_MIN_PART_SIZE_MB=10        — files smaller than this stay single-stream
//   NEXT_PUBLIC_SLOW_SPEED_KBS=15          — a part under this (KB/s) counts as slow
//   NEXT_PUBLIC_SLOW_WINDOW_SEC=15         — sustained slow for this long → reconnect
//   NEXT_PUBLIC_STALL_TIMEOUT_SEC=10       — zero bytes for this long → reconnect
//   NEXT_PUBLIC_MAX_SLOW_RESTARTS=8        — max auto reconnects per part (raised
//                                            by manual refresh: limit += 8 each click)
const MAX_PARALLEL_PARTS = envInt("NEXT_PUBLIC_MAX_PARALLEL_PARTS", 4);
const MIN_PART_SIZE = envInt("NEXT_PUBLIC_MIN_PART_SIZE_MB", 5) * 1024 * 1024;
const PART_MAX_ATTEMPTS = 8;           // per part, incl. mid-stream resume attempts
const PART_RETRY_DELAY_MS = 800;
const SLOW_SPEED_KBS = envInt("NEXT_PUBLIC_SLOW_SPEED_KBS", 15);
const SLOW_WINDOW_MS = envInt("NEXT_PUBLIC_SLOW_WINDOW_SEC", 15) * 1000;
const STALL_TIMEOUT_MS = envInt("NEXT_PUBLIC_STALL_TIMEOUT_SEC", 10) * 1000;
export const MAX_SLOW_RESTARTS = envInt("NEXT_PUBLIC_MAX_SLOW_RESTARTS", 6);
const HEADER_TIMEOUT_MS = 15000;  // a dead tunnel must fail fast, not hang

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

/** Max parallel parts for cloud download. */
type CloudPartState = {
  index: number;
  start: number;
  end: number;
  receivedBytes: number;
  status: "pending" | "downloading" | "completed" | "failed";
  error?: string;
  speedBytesPerSecond?: number;
  restartCount?: number;       // total reconnects (manual refresh)
  manualRestartCount?: number; // reconnects triggered by the UI refresh button
  reconnecting?: boolean;      // a refresh is in flight (button disabled + spinning)
};

function buildCloudParts(totalBytes: number, numParts: number): CloudPartState[] {
  if (totalBytes <= 0 || numParts <= 1) {
    return [{ index: 0, start: 0, end: Math.max(0, totalBytes - 1), receivedBytes: 0, status: "pending" }];
  }
  const partSize = Math.ceil(totalBytes / numParts);
  const parts: CloudPartState[] = [];
  for (let i = 0; i < numParts; i++) {
    const start = i * partSize;
    const end = Math.min(start + partSize - 1, totalBytes - 1);
    if (start > end) break;
    parts.push({ index: i, start, end, receivedBytes: 0, status: "pending" });
  }
  return parts;
}

/**
 * Split a file into equal, contiguous byte ranges.
 */
export function buildParts(totalBytes: number, requestedParts: number): WorkerFileTransferPart[] {
  if (totalBytes <= 0) return [];
  const partCount = Math.min(Math.max(1, requestedParts), getMaxPartsForSize(totalBytes));
  if (partCount <= 1) {
    return [{ index: 0, start: 0, end: totalBytes - 1, receivedBytes: 0, status: "pending", restartCount: 0 }];
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
      restartCount: 0,
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

// Shared in-flight connection fetches — when the cache misses (e.g. after a
// token refresh), concurrent callers (parallel parts + SSE) must not each
// round-trip the backend; one fetch serves them all.
const _connectionInFlight = new Map<string, Promise<WorkerConnection>>();

/** Fetch (or return cached) connection details for a worker. */
async function getConnection(workerId: string): Promise<WorkerConnection> {
  const cached = _cache.get(workerId);
  if (cached) return cached;

  const inFlight = _connectionInFlight.get(workerId);
  if (inFlight) return inFlight;

  const fetchConnection = (async () => {
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
  })().finally(() => {
    _connectionInFlight.delete(workerId);
  });

  _connectionInFlight.set(workerId, fetchConnection);
  return fetchConnection;
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

// Live download controls, keyed by transferId (`workerId:downloadId:fileIndex`).
// Module-scoped so they survive page navigation — the page remounts but the
// in-flight download (and its per-part controllers) do not.
const _activeControls = new Map<string, WorkerDownloadControl>();

// Restart callbacks for failed parts — keyed by transferId. Allows manual
// restart to re-run downloadPart for a part that has already failed and
// cleaned up its flags/controller.
const _restartCallbacks = new Map<string, (partIndex: number) => void>();

/** Restart a part of an active worker→browser download by transferId. */
export function restartWorkerPart(transferId: string, partIndex: number): void {
  _activeControls.get(transferId)?.restartPart(partIndex);
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
export interface WorkerDownloadControl {
  /** Ask a part to drop its current stream and resume from its offset. */
  restartPart: (index: number) => void;
}

export function downloadWorkerLocalFile(
  workerId: string,
  downloadId: string,
  file: WorkerLocalFile,
  onProgress?: (receivedBytes: number, totalBytes: number | null, parts?: WorkerFileTransferPart[]) => void,
  requestedParts?: number,
): WorkerDownloadControl & { promise: Promise<void> } {
  // Per-part restart coordination, shared between the auto slow/stall
  // detector inside downloadPart and manual restarts from the UI.
  const restartFlags = new Map<number, { requested: boolean; manual: boolean; autoRestarts: number; autoRestartLimit: number; backoffLevel: number }>();
  const partControllers = new Map<number, AbortController>();

  const run = async (): Promise<void> => {
    // The picker must happen before a transfer exists. Cancelling it therefore
    // creates no progress state and makes no request to the worker — the
    // AbortError propagates and callers treat it as a clean silent no-op.
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

    // ── Parallel multi-part download ───────────────────────────────────────
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

    // Reconnect gate: at most ONE part may be reconnecting at a time (plus a
    // little jitter), so slow/stalled parts can't restart in a cascade that
    // starves every connection on the tunnel and pauses the whole download.
    let activeReconnects = 0;
    const reconnectWaiters: (() => void)[] = [];
    const acquireReconnectSlot = async () => {
      if (activeReconnects === 0) {
        activeReconnects = 1;
        return;
      }
      await new Promise<void>((resolve) => reconnectWaiters.push(resolve));
      activeReconnects = 1;
    };
    const releaseReconnectSlot = () => {
      activeReconnects = 0;
      reconnectWaiters.shift()?.();
    };

    /** Wait to reconnect this part: one slot at a time, growing backoff. */
    const waitBeforeReconnect = async (reconnectCount: number) => {
      await acquireReconnectSlot();
      try {
        await sleep(Math.min(2000 * Math.max(1, reconnectCount), 8000) + Math.random() * 500);
      } finally {
        releaseReconnectSlot();
      }
    };

  /**
   * Download one part with mid-stream resume: if the stream breaks partway
   * (common with flaky tunnels), the part retries from its current offset
   * instead of failing — already-written bytes are never re-fetched.
   *
   * Slow or stalled parts are also reconnected proactively: tunnel services
   * throttle per connection, so a part that crawls along on a throttled
   * connection can often be rescued by opening a fresh connection from the
   * same offset.
   */
  const downloadPart = async (part: WorkerFileTransferPart, initialAutoRestarts: number = 0): Promise<void> => {
    part.status = "downloading";
    reportProgress();

    // The restart flag lives across attempts; the AbortController does not —
    // an aborted signal stays aborted forever, so a reconnecting part must
    // get a FRESH controller (and fresh fetch signal) on its next attempt,
    // otherwise the new request instantly rejects with AbortError and the
    // part is misread as cancelled. The controller is recreated inside the
    // loop below; it follows the parent transfer's cancel and is exposed via
    // restartPart() for manual UI-triggered reconnects.
    const flag = { requested: false, manual: false, autoRestarts: initialAutoRestarts, autoRestartLimit: initialAutoRestarts + MAX_SLOW_RESTARTS, backoffLevel: 0 };
    restartFlags.set(part.index, flag);

    let partController = new AbortController();
    const onParentAbort = () => partController.abort();
    controller.signal.addEventListener("abort", onParentAbort, { once: true });

    const cleanup = () => {
      controller.signal.removeEventListener("abort", onParentAbort);
      partControllers.delete(part.index);
      restartFlags.delete(part.index);
    };

    let tunnelFailures = 0;

    try {
      for (let attempt = 1; attempt <= PART_MAX_ATTEMPTS; attempt++) {
        // Fresh controller for this attempt (see comment above). The restart flags
        // are reset first, so a click that grabs the new controller can never
        // be wiped by our own reset after it landed.
        flag.requested = false;
        flag.manual = false;
        partController = new AbortController();
        partControllers.set(part.index, partController);
        part.autoRestartLimit = flag.autoRestartLimit;
        // A connection attempt is now in flight (initial, reconnect, or
        // failure retry) — the UI spins the refresh button until bytes flow,
        // the part completes, or the part fails.
        part.reconnecting = true;
        reportProgress();

        // The whole transfer was cancelled — stop before starting a new stream
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }

        const startOffset = part.start + part.receivedBytes;
        if (startOffset > part.end) {
          cleanup();
          part.status = "completed";
          part.reconnecting = false;
          reportProgress();
          return;
        }

        let res: Response;
        // Timeout only the header phase: a dead tunnel must fail fast (and
        // count as a tunnel-level failure → connection refresh) instead of
        // hanging forever. The timer is cleared once headers arrive, so the
        // body stream is unaffected.
        const headerController = new AbortController();
        const headerTimeoutId = setTimeout(() => {
          headerController.abort(new DOMException("Tunnel did not respond in time", "TimeoutError"));
        }, HEADER_TIMEOUT_MS);
        const requestSignal = AbortSignal.any([partController.signal, headerController.signal]);
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
            requestSignal,
          );
        } catch (error: any) {
          if (error?.name === "AbortError") {
            // A real cancel aborts the parent controller first — anything
            // else that killed this part's stream is a voluntary reconnect
            // (auto slow/stall, manual refresh, or a header timeout that
            // landed as AbortError on older browsers).
if (controller.signal.aborted) throw error; // real cancel
            flag.requested = false;
            const wasManual = flag.manual;
            flag.manual = false;
            if (wasManual) part.manualRestartCount = (part.manualRestartCount ?? 0) + 1;
            part.restartCount = (part.restartCount ?? 0) + 1;
            part.reconnecting = true;
            part.autoRestartLimit = flag.autoRestartLimit;
            reportProgress();
            // Voluntary reconnects are unlimited — don't consume the failure
            // retry budget (attempt resets to 1 via the for-loop increment).
            attempt = 0;
            await waitBeforeReconnect(flag.backoffLevel);
            continue;
          }
          // Network-level failure (the request never completed) — the tunnel
          // itself may be down or its URL stale (worker re-tunnelled). Count
          // these; every 2nd one drops the cached connection so the next
          // request re-fetches a fresh URL/token from the backend (dedup'd).
          tunnelFailures++;
          console.warn(`[workerConnection] part ${part.index + 1} fetch failed (attempt ${attempt}/${PART_MAX_ATTEMPTS}):`, error?.message ?? error);
          // A failed connection also counts toward the auto budget: the
          // retry keeps consuming it until the limit or success.
          flag.autoRestarts++;
          part.restartCount = (part.restartCount ?? 0) + 1;
          if (flag.autoRestarts >= flag.autoRestartLimit) {
            throw new Error(`Part ${part.index + 1} connection kept failing — gave up after ${flag.autoRestarts} auto reconnects (limit ${flag.autoRestartLimit})`);
          }
          if (attempt === PART_MAX_ATTEMPTS) throw error;
          if (tunnelFailures % 2 === 0) {
            console.warn(`[workerConnection] ${tunnelFailures} tunnel-level failures — refreshing worker connection from backend`);
            invalidateWorkerConnection(workerId);
          }
          await waitBeforeReconnect(tunnelFailures);
          continue;
        } finally {
          clearTimeout(headerTimeoutId);
        }

        // 200 = server ignored our range — parallel download not possible
        if (res.status === 200) {
          const contentType = res.headers.get("Content-Type") ?? "";
          if (contentType.includes("text/html")) {
            // Tunnel served an interstitial page instead of the file — same
            // tunnel-level treatment: count it, refresh on repeat, back off.
            tunnelFailures++;
            console.warn(`[workerConnection] part ${part.index + 1} got an HTML screen (attempt ${attempt}/${PART_MAX_ATTEMPTS})`);
            flag.autoRestarts++;
            part.restartCount = (part.restartCount ?? 0) + 1;
            if (flag.autoRestarts >= flag.autoRestartLimit) {
              throw new Error(`Part ${part.index + 1} tunnel kept serving an interstitial page — gave up after ${flag.autoRestarts} auto reconnects (limit ${flag.autoRestartLimit})`);
            }
            if (attempt === PART_MAX_ATTEMPTS) throw new Error("Tunnel served an interstitial page instead of the file");
            if (tunnelFailures % 2 === 0) {
              console.warn(`[workerConnection] ${tunnelFailures} tunnel-level failures — refreshing worker connection from backend`);
              invalidateWorkerConnection(workerId);
            }
            await waitBeforeReconnect(tunnelFailures);
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

        // Read the stream; a break mid-stream resumes on the next attempt.
        // While reading, watch for slow/stalled throughput and reconnect the
        // part on a fresh connection when it crawls below SLOW_SPEED_KBS.
        const reader = res.body.getReader();
        let windowStartAt = Date.now();
        let bytesAtWindowStart = 0;
        let lastChunkAt = Date.now();
        let streamError: unknown = null;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writeChunk(part, value);
            part.receivedBytes += value.byteLength;
            totalReceived += value.byteLength;
            if (part.reconnecting) {
              // Bytes are flowing again — the reconnect finished.
              part.reconnecting = false;
            }
            reportProgress();

            const now = Date.now();
            // Smoothed per-part throughput (EMA): the first chunk of a
            // reconnect attempt measures from a fresh base, so the display
            // recovers quickly instead of showing the reconnect gap.
            const dt = (now - lastChunkAt) / 1000;
            if (dt > 0) {
              const instant = value.byteLength / dt;
              part.speedBytesPerSecond =
                part.speedBytesPerSecond ? part.speedBytesPerSecond * 0.7 + instant * 0.3 : instant;
            }
            const elapsed = now - windowStartAt;
            let restartReason: string | null = null;
            if (now - lastChunkAt >= STALL_TIMEOUT_MS) {
              restartReason = `stalled for ${STALL_TIMEOUT_MS / 1000}s`;
            } else if (elapsed >= SLOW_WINDOW_MS) {
              const speedKbs = (part.receivedBytes - bytesAtWindowStart) / (elapsed / 1000) / 1024;
              if (speedKbs < SLOW_SPEED_KBS) restartReason = `slow (${speedKbs.toFixed(1)} KB/s)`;
              bytesAtWindowStart = part.receivedBytes;
              windowStartAt = now;
            }
            lastChunkAt = now;

            if (restartReason) {
              if (flag.autoRestarts >= flag.autoRestartLimit) {
                throw new Error(`Part ${part.index + 1} ${restartReason} — gave up after ${flag.autoRestarts} auto reconnects (limit ${flag.autoRestartLimit})`);
              }
              flag.autoRestarts++;
              flag.backoffLevel++;
              console.warn(`[workerConnection] part ${part.index + 1} ${restartReason} — reconnecting (${flag.autoRestarts}/${flag.autoRestartLimit}) at ${((part.receivedBytes - part.start) / (part.end - part.start + 1) * 100).toFixed(0)}% of part`);
              flag.requested = true;
              partController.abort();
              break;
            }
          }
        } catch (error: any) {
          if (error?.name === "AbortError") {
            // Real cancel = the parent controller aborted first; anything
            // else is a voluntary reconnect (auto slow/stall or manual).
if (controller.signal.aborted) throw error; // real cancel
            flag.requested = false;
            const wasManual = flag.manual;
            flag.manual = false;
            if (wasManual) part.manualRestartCount = (part.manualRestartCount ?? 0) + 1;
            part.restartCount = (part.restartCount ?? 0) + 1;
            part.reconnecting = true;
            part.autoRestartLimit = flag.autoRestartLimit;
            reportProgress();
            // Voluntary reconnects are unlimited — don't consume the failure
            // retry budget (attempt resets to 1 via the for-loop increment).
            attempt = 0;
            await waitBeforeReconnect(flag.backoffLevel);
            continue;
          }
          streamError = error;
        }
        if (flag.requested) {
          // Reconnect triggered between chunks (no read was pending to reject)
          flag.requested = false;
          const wasManual = flag.manual;
          flag.manual = false;
          if (wasManual) part.manualRestartCount = (part.manualRestartCount ?? 0) + 1;
          part.restartCount = (part.restartCount ?? 0) + 1;
          part.reconnecting = true;
          part.autoRestartLimit = flag.autoRestartLimit;
          reportProgress();
          // Voluntary reconnects are unlimited — don't consume the failure
          // retry budget (attempt resets to 1 via the for-loop increment).
          attempt = 0;
          await waitBeforeReconnect(flag.backoffLevel);
          continue;
        }
        if (streamError) {
          console.warn(`[workerConnection] part ${part.index + 1} stream broke at ${part.receivedBytes}/${part.end - part.start + 1} bytes (attempt ${attempt}/${PART_MAX_ATTEMPTS}):`, (streamError as any)?.message ?? streamError);
          // A broken stream also counts toward the auto budget — the new
          // connection it creates is an auto reconnect too.
          flag.autoRestarts++;
          part.restartCount = (part.restartCount ?? 0) + 1;
          if (flag.autoRestarts >= flag.autoRestartLimit) {
            throw new Error(`Part ${part.index + 1} stream kept breaking — gave up after ${flag.autoRestarts} auto reconnects (limit ${flag.autoRestartLimit})`);
          }
          if (attempt === PART_MAX_ATTEMPTS) throw streamError;
          await sleep(PART_RETRY_DELAY_MS * attempt);
          continue;
        }

        cleanup();
        part.status = "completed";
        part.reconnecting = false;
        reportProgress();
        return;
      }

      // The attempt loop can only exit via return/throw; voluntary reconnects
      // reset the counter, so reaching here means the failure retry budget was
      // exhausted without the part completing — fail loudly, never silently.
      throw new Error(`Part ${part.index + 1} could not finish after ${PART_MAX_ATTEMPTS} attempts`);
    } catch (error) {
      part.status = "failed";
      part.reconnecting = false;
      // Save autoRestarts so the restart callback can extend the limit
      (part as any)._lastAutoRestarts = flag.autoRestarts;
      cleanup();
      reportProgress();
      throw error;
    }
  };

    // Register restart callback so manual refresh can re-run a failed part.
    _restartCallbacks.set(transferId, (partIndex: number) => {
      const part = parts[partIndex];
      if (!part || part.status === "completed") return;
      const lastAutoRestarts = (part as any)._lastAutoRestarts ?? 0;
      part.restartCount = (part.restartCount ?? 0) + 1;
      part.manualRestartCount = (part.manualRestartCount ?? 0) + 1;
      part.status = "pending";
      part.reconnecting = false;
      reportProgress();
      downloadPart(part, lastAutoRestarts).catch(() => {});
    });

    // Close the writable (or assemble and save the blob) exactly once, when all
    // parts have completed — including parts completed via a manual refresh.
    const finalize = async (): Promise<void> => {
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
    };

    // Start all parts and poll until every part reaches "completed". Restarted
    // parts (via the restart callback) run as independent promises — the polling
    // loop detects status changes and keeps waiting until they finish, so the
    // transfer only completes once ALL parts (including restarted ones) are done.
    //
    // When all active parts finish but some are failed (hit their auto-reconnect
    // limit), Phase 2 kicks in: failed parts are automatically restarted with an
    // extended limit (+MAX_SLOW_RESTARTS), same as a manual refresh click. If
    // Phase 2 parts also fail, the loop does NOT tear the transfer down; it idles,
    // keeping the transfer alive so the user can manually refresh a failed part
    // (via _restartCallbacks). Once every part eventually completes, finalize()
    // closes the file and the transfer resolves.
    const runAllParts = async (): Promise<void> => {
      let specialError: Error | null = null;
      let phase2Triggered = false;
      let idleReported = false;

      for (const part of parts) {
        if (part.status !== "completed") {
          downloadPart(part).catch((err) => {
            if (err instanceof RangeNotSupportedError || (err as any)?.name === "AbortError") {
              specialError = err;
            }
          });
        }
      }

      while (true) {
        await new Promise<void>((r) => setTimeout(r, 100));

        if (specialError) throw specialError;

        if (parts.every((p) => p.status === "completed")) {
          await finalize();
          return;
        }

        const hasActive = parts.some((p) => p.status === "downloading" || p.status === "pending");
        const failedParts = parts.filter((p) => p.status === "failed");

        if (!hasActive && failedParts.length > 0) {
          if (!phase2Triggered) {
            // Phase 2: auto-retry failed parts with extended limit
            phase2Triggered = true;
            idleReported = false;
            for (const part of failedParts) {
              const lastAutoRestarts = (part as any)._lastAutoRestarts ?? 0;
              part.phase2 = true;
              part.restartCount = (part.restartCount ?? 0) + 1;
              part.status = "pending";
              part.reconnecting = false;
              reportProgress();
              downloadPart(part, lastAutoRestarts).catch((err) => {
                if (err instanceof RangeNotSupportedError || (err as any)?.name === "AbortError") {
                  specialError = err;
                }
              });
            }
            continue;
          }
          // Phase 2 already ran and parts failed again — idle and wait for a
          // manual refresh of a failed part instead of failing the transfer.
          if (!idleReported) {
            idleReported = true;
            reportProgress();
          }
        }
      }
    };

    try {
      if (handle) {
        // keepExistingData: positional writes must not truncate the file
        writable = await handle.createWritable({ keepExistingData: true });
      }

      await runAllParts();
    } catch (error) {
      // Only abort for real cancellations — not part failures — so manual
      // restart can re-run failed parts via _restartCallbacks.
      const isRealCancel = (error as any)?.name === "AbortError";
      if (isRealCancel) {
        controller.abort();
        if (writable) await writable.abort().catch(() => undefined);
      }
      console.warn("[workerConnection] parallel transfer failed:", error);

      // Worker doesn't support ranges — re-download as a single stream
      if (error instanceof RangeNotSupportedError) {
        controller.abort();
        if (writable) await writable.abort().catch(() => undefined);
        console.warn("[workerConnection] worker does not support range queries — falling back to single stream");
        await writeResponseStream(workerId, filePath, handle, file, totalBytes, onProgress);
        return;
      }
      throw error;
    }
  };

  const transferId = `${workerId}:${downloadId}:${file.index}`;
  const promise = run();
  const control: WorkerDownloadControl = {
    restartPart: (index: number) => {
      const flag = restartFlags.get(index);
      const partController = partControllers.get(index);
      if (flag && partController) {
        flag.requested = true;
        flag.manual = true;
        // Manual refresh extends the auto-reconnect budget instead of resetting
        // it: newLimit = MAX_SLOW_RESTARTS + currentAutoCount, so the count
        // keeps running (e.g. 3/8 → 3/11) and each click grants +8 more
        // headroom from the current count. The reconnect backoff restarts from
        // a low level so a manual refresh reconnects quickly.
        flag.autoRestartLimit = flag.autoRestarts + MAX_SLOW_RESTARTS;
        flag.backoffLevel = 0;
        partController.abort();
      } else {
        // Part has failed and cleaned up — re-run it via the restart callback
        _restartCallbacks.get(transferId)?.(index);
      }
    },
  };
  _activeControls.set(transferId, control);
  // .then(ok, err) instead of .finally(): a finally-chained promise inherits
  // the rejection and — being unawaited — turns every failed download (and
  // picker cancels) into an "Uncaught (in promise) ..." console error.
  promise.then(
    () => maybeDropControl(),
    () => {
      // On failure, keep the control AND the restart callback alive so a manual
      // refresh can re-run failed parts via _restartCallbacks (the orchestration
      // loop stays alive waiting for them). Cleanup happens on success or when
      // the transfer is discarded via maybeDropControl.
    },
  );
  function maybeDropControl() {
    // Only drop our own registration (a later download of the same file
    // must not lose its control when this older one settles).
    if (_activeControls.get(transferId) === control) _activeControls.delete(transferId);
    _restartCallbacks.delete(transferId);
  }

  return {
    promise,
    restartPart: control.restartPart,
  };
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
    // The tunnel may have been re-created (Pinggy URL changes on restart),
    // so drop the cached connection — the next getConnection() (dedup'd,
    // one shared backend fetch) picks up a fresh URL/token.
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
    // browserTab.location.replace(`${"http"+conn.pinggyUrl.slice(5)}${data.startPath}`);
    browserTab.location.href = `${"http"+conn.pinggyUrl.slice(5)}${data.startPath}`
    // window.location.href = `${"http"+conn.pinggyUrl.slice(5)}${data.startPath}`
  } catch (error) {
    browserTab.close();
    throw error;
  }
}

/**
 * Download a cloud file (MEGA share URL) directly to disk using megajs.
 * Splits into parallel parts, streams each to the File System Access API writable.
 * Falls back to blob download if showSaveFilePicker is unavailable.
 *
 * Returns { promise, cancel } — same pattern as downloadWorkerLocalFile.
 */
export function downloadCloudFileToDisk(
  shareUrl: string,
  fileName: string,
  totalBytes: number,
  requestedParts?: number,
  onProgress?: (receivedBytes: number, totalBytes: number, parts: CloudPartState[]) => void,
  onCheckingChange?: (checking: boolean) => void,
): { promise: Promise<void>; cancel: () => void; retryPart: (partIndex: number) => void } {
  const numParts = requestedParts ?? (isMultiPartPossible(totalBytes) ? getMaxPartsForSize(totalBytes) : 1);
  const parts = buildCloudParts(totalBytes, numParts);
  let totalReceived = 0;
  let isCancelled = false;
  // Serializes ALL part writes through one chain so no in-flight writeChunk can
  // race writable.close() in finalize() ("Cannot write to a closing writable stream").
  let writeChain = Promise.resolve();

  const reportProgress = () => onProgress?.(totalReceived, totalBytes, parts);

  let writable: any = null;
  let closed = false;
  let blobParts = new Map<number, ArrayBuffer[]>();
  let resolvedFileName = fileName;
  // Per-part control: lets retryPart cancel the in-flight megajs stream and
  // invalidate the running runPart (via generation) before starting a fresh,
  // byte-offset-resumed download for that part.
  const partCtl = new Map<number, { gen: number; stream?: any }>();

  // Destroy a megajs single-connection stream WITHOUT leaking the unhandled
  // "BodyStreamBuffer was aborted" rejection (megajs's detached reader pump has
  // no .catch). We temporarily swallow that specific unhandled rejection while
  // the destroy-induced abort settles.
  const destroyMegajsStream = (stream: any): void => {
    if (!stream) return;
    const handler = (e: PromiseRejectionEvent) => {
      const reason: any = e?.reason;
      const msg = typeof reason?.message === "string" ? reason.message : String(reason ?? "");
      if (/aborted/i.test(msg)) e.preventDefault();
    };
    window.addEventListener("unhandledrejection", handler);
    try { stream.destroy?.(); } catch {}
    setTimeout(() => window.removeEventListener("unhandledrejection", handler), 500);
  };

    const MAX_ABORT_RETRIES = 3;

    const runPart = async (part: CloudPartState): Promise<void> => {
      part.status = "downloading";
      reportProgress();

      if (isCancelled) return;

      let ctl = partCtl.get(part.index) ?? { gen: 0 };
      const myGen = ctl.gen;
      // Register this part's control entry immediately so the initial download
      // is NOT misread as superseded (the old "?? -1" fallback made runPart
      // return early on first run: an unregistered part compared -1 against gen 0).
      partCtl.set(part.index, ctl);
      // A runPart superseded by a manual refresh stops quietly instead of writing.
      const superseded = () => {
        if (isCancelled) return true;
        const cur = partCtl.get(part.index);
        return cur === undefined || cur.gen !== myGen;
      };

      let activeStream: any = null;
      let settled = false;
      let abortRetryCount = 0;
      let lastChunkAt = 0;

      while (true) {
        try {
          if (superseded()) return;
          activeStream = null;
          settled = false;
          const { File } = await import("megajs");
          const freshFile = File.fromURL(shareUrl);
          freshFile.api.userAgent = "StreamLift (+https://streamlift.app)";
          await freshFile.loadAttributes();

          // A manual refresh may have superseded this attempt while we were
          // fetching file attributes — don't create/register its stream then.
          if (superseded()) return;

          // Resume from the exact byte already written for this part (blanket
          // byte-offset resume, mirroring the server-worker path). We keep
          // maxConnections: 1 here — the megajs multi-connection path does not
          // reliably stream to the browser in this setup (download would hang
          // after the file picker). A manual refresh destroys the single-
          // connection stream via a scoped rejection suppressor (see retryPart).
          const startOffset = part.start + part.receivedBytes;
          if (startOffset > part.end) return;
          const stream = freshFile.download({ start: startOffset, end: part.end, maxConnections: 1 });
          activeStream = stream;
          ctl.stream = stream;
          partCtl.set(part.index, ctl);

          await new Promise<void>((resolve, reject) => {
            stream.on("data", (chunk: Uint8Array) => {
              if (isCancelled || settled || superseded()) return;
              const buf = new Uint8Array(chunk);
              // Data is flowing again — a refresh/reconnect has finished.
              if (part.reconnecting) part.reconnecting = false;
              const now = Date.now();
              // Smoothed per-part throughput (EMA). The first chunk of an attempt
              // measures from a fresh base so the display recovers quickly instead
              // of showing the reconnect gap.
              const dt = lastChunkAt ? (now - lastChunkAt) / 1000 : 0;
              lastChunkAt = now;
              if (dt > 0) {
                const instant = buf.length / dt;
                part.speedBytesPerSecond =
                  part.speedBytesPerSecond ? part.speedBytesPerSecond * 0.7 + instant * 0.3 : instant;
              }
              writeChain = writeChain.then(() => writeChunk(part, buf)).then((ok) => {
                if (ok) {
                  part.receivedBytes += buf.length;
                  totalReceived += buf.length;
                }
                reportProgress();
              });
            });
            stream.on("end", () => { if (!settled) { settled = true; writeChain.then(resolve).catch(reject); } });
            stream.on("error", (err: Error) => {
              if (settled) return;
              settled = true;
              reject(err);
            });
          });

          // Completion is only valid once the full part length has been written;
          // a short / interrupted resume must not be treated as done.
          const partLength = part.end - part.start + 1;
          if (part.receivedBytes < partLength) {
            part.status = "failed";
            part.error = "part interrupted — refresh this part";
            part.reconnecting = false;
            reportProgress();
            return;
          }
          part.status = "completed";
          reportProgress();
          return;
        } catch (err: any) {
          settled = true;
          destroyMegajsStream(activeStream);

          if (isCancelled || superseded()) return;

          if (isBandwidthLimitError(err)) {
            part.status = "failed";
            const anyErr = err as any;
            const timeLeft = anyErr?.timeLimit;
            const seconds = Number.parseInt(String(timeLeft ?? ""), 10);
            part.error = Number.isFinite(seconds) && seconds > 0
              ? `Transfer quota exceeded — try again in ${seconds}s`
              : "Transfer quota exceeded";
            part.reconnecting = false;
            reportProgress();
            throw err;
          }

          if (err?.name === "AbortError" && abortRetryCount < MAX_ABORT_RETRIES) {
            abortRetryCount++;
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }

          part.status = "failed";
          part.error = err?.message ?? "Download failed";
          part.reconnecting = false;
          reportProgress();
          return;
        }
      }
    };

  const writeChunk = (part: CloudPartState, chunk: Uint8Array): Promise<boolean> => {
    // All writes for every part are serialized through the shared writeChain, and
    // receivedBytes only advances (in the data handler) after a successful write,
    // so position below is always exactly the next unwritten byte. We guard only
    // against writing past the part's end (a malformed range would corrupt).
    const position = part.start + part.receivedBytes;
    if (position > part.end) return Promise.resolve(false);
    if (writable) {
      if (closed) return Promise.resolve(false);
      return writable.write({ type: "write", position, data: chunk }).then(() => true).catch((err: any) => {
        // A write landing on a stream that was closed/destroyed by a manual
        // refresh or by finalize is safe to drop — the byte is re-fetched by the
        // resumed stream or the file is already being finalized. Genuine disk
        // errors still propagate so the part is marked failed.
        const msg = String(err?.message ?? "");
        if (closed || /destroyed|closing|invalid state/i.test(msg)) return false;
        throw err;
      });
    }
    const buffers = blobParts.get(part.index) ?? [];
    buffers.push(chunk.slice().buffer);
    blobParts.set(part.index, buffers);
    return Promise.resolve(true);
  };

  // Only mark the transfer finalizable when every part is completed AND its full
  // byte range has been written (a short resume must never produce a bad file).
  const allPartsDone = () => parts.every((p) => p.status === "completed" && p.receivedBytes >= (p.end - p.start + 1));

  let finalized = false;
  const finalize = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;
    // Drain every queued writeChunk before closing so no write races close().
    await writeChain;
    if (writable) {
      closed = true;
      await writable.close();
    } else {
      const allParts = [...blobParts.entries()].sort(([a], [b]) => a - b);
      const blob = new Blob(allParts.flatMap(([, buffers]) => buffers), { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = resolvedFileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  };

  let resolveCompletion: (() => void) | undefined;
  let rejectCompletion: ((err: any) => void) | undefined;

  const completionPromise = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  (async () => {
    try {
      const { File } = await import("megajs");
      const initFile = File.fromURL(shareUrl);
      initFile.api.userAgent = "StreamLift (+https://streamlift.app)";
      await initFile.loadAttributes();
      resolvedFileName = initFile.name ?? fileName;

      // Pre-flight: test if MEGA allows this download before asking for save
      // location. Uses a raw MEGA API check (not megajs, whose .download() fans a
      // range out into many chunk URLs) so we get a direct, explicit 509/bandwidth
      // signal. If the quota window is spent, the save picker is never shown.
      onCheckingChange?.(true);
      const quotaSecondsLeft = await checkMegaQuota(shareUrl, initFile.size ?? 0);
      onCheckingChange?.(false);
      if (quotaSecondsLeft !== null) {
        const msg = quotaSecondsLeft > 0
          ? `Transfer quota exceeded — try again in ${quotaSecondsLeft}s`
          : "Transfer quota exceeded";
        throw new Error(msg);
      }

      const picker = (window as any).showSaveFilePicker;
      const handle = typeof picker === "function"
        ? await picker({ suggestedName: resolvedFileName })
        : null;

      if (handle) {
        writable = await handle.createWritable();
      }

      onCheckingChange?.(false);

      await Promise.all(parts.map((p) => runPart(p)));
      if (isCancelled) { resolveCompletion?.(); return; }

      if (allPartsDone()) {
        await finalize();
        resolveCompletion?.();
      }
    } catch (err: any) {
      const isBandwidth = isBandwidthLimitError(err);
      const isPickerCancel = err?.name === "AbortError";
      const message = isBandwidth ? "Transfer quota exceeded" : (err?.message ?? "Download failed");
      for (const part of parts) {
        if (part.status !== "completed") {
          part.status = "failed";
          part.error = message;
        }
      }
      reportProgress();
      if (isPickerCancel) {
        rejectCompletion?.(err);
      } else {
        rejectCompletion?.(new Error(message));
      }
    }
  })();

  return {
    promise: completionPromise,
    cancel: () => { isCancelled = true; },
    retryPart: (partIndex: number) => {
      const part = parts[partIndex];
      if (!part || part.status === "completed" || part.reconnecting) return;
      // Cancel the in-flight megajs stream first so no second connection keeps
      // downloading/writing the same part. Bump the generation so the superseded
      // runPart stops quietly instead of writing or marking the part failed.
      const ctl = partCtl.get(part.index);
      if (ctl) {
        ctl.gen += 1;
        const old = ctl.stream;
        if (old) destroyMegajsStream(old);
        partCtl.set(part.index, ctl);
      }
      part.error = undefined;
      part.reconnecting = true;
      part.manualRestartCount = (part.manualRestartCount ?? 0) + 1;
      part.restartCount = (part.restartCount ?? 0) + 1;
      // Resume from the exact byte already written (byte-offset resume): keep
      // receivedBytes so the fresh stream continues where the old one left off.
      part.status = "downloading";
      reportProgress();
      runPart(part).then(() => {
        if (!isCancelled && allPartsDone()) {
          finalize().then(() => resolveCompletion?.()).catch(() => {});
        }
      }).catch(() => {});
    },
  };
}
