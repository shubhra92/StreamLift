/**
 * WorkerClient — tab-side singleton that talks to the SharedWorker.
 *
 * Responsibilities:
 *  - Connect to the SharedWorker (or fall back to SyncManager if unavailable)
 *  - Forward commands from hooks to the worker
 *  - Distribute worker messages to registered callbacks
 *  - Write received data to IDB and emit to subscribed hooks
 */

import {
  upsertDownloads,
  upsertWorkers,
  patchWorkersRuntime,
  getAllDownloads,
  getAllWorkers,
  deleteDownloadFromIDB,
  deleteWorkerFromIDB,
  getCursor,
  setCursor,
} from "@/app/lib/idb/IDBStore";
import { runGuestGuard } from "@/app/lib/idb/guestGuard";
import type {
  TabToWorkerMessage,
  WorkerToTabMessage,
  SyncEntity,
  ProgressPayload,
  WorkerStatusPayload,
} from "./workerProtocol";
import type { IDBFileDownload, IDBWorker } from "@/app/lib/idb/schema";
import type { FileDownload, Worker } from "@/app/db/schema";

// ─── Callback types ───────────────────────────────────────────────────────────

type DownloadDataCallback = (rows: IDBFileDownload[]) => void;
type WorkerDataCallback   = (rows: IDBWorker[]) => void;
type ProgressCallback     = (payload: ProgressPayload) => void;
type NetworkCallback      = (status: "online" | "offline") => void;
type WorkerStatusCallback = (status: WorkerStatusPayload) => void;

// ─── WorkerClient ─────────────────────────────────────────────────────────────

class WorkerClient {
  private static instance: WorkerClient | null = null;

  private worker: SharedWorker | null = null;
  private port: MessagePort | null = null;
  private initialized = false;
  private ready = false;
  private pendingMessages: TabToWorkerMessage[] = [];

  // ── Data subscribers ──────────────────────────────────────────────────────
  private downloadSubs: Set<DownloadDataCallback> = new Set();
  private torrentSubs:  Set<DownloadDataCallback> = new Set();
  private workerSubs:   Set<WorkerDataCallback>   = new Set();

  // ── Dependency registry ───────────────────────────────────────────────────
  // Tracks which entities THIS TAB currently needs. Whenever it changes,
  // a "declare" message is sent to the worker so it can recompute the union
  // of all tabs' needs and start/stop intervals accordingly.
  private needs: Set<SyncEntity> = new Set();

  // ── Progress subscribers ──────────────────────────────────────────────────
  private progressSubs: Set<ProgressCallback> = new Set();

  // ── Network subscribers ───────────────────────────────────────────────────
  private networkSubs: Set<NetworkCallback> = new Set();

  // ── Worker status subscribers: workerId → Set<callback> ──────────────────
  private workerStatusSubs: Map<string, Set<WorkerStatusCallback>> = new Map();

  // ── Fallback to SyncManager if SharedWorker unavailable ──────────────────
  private _fallback: any = null;
  private get isFallback() { return this._fallback !== null; }

  private constructor() {}

  static getInstance(): WorkerClient {
    if (!WorkerClient.instance) {
      WorkerClient.instance = new WorkerClient();
    }
    return WorkerClient.instance;
  }

  // ─── Init ────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    await runGuestGuard();

    if (typeof window === "undefined") return;

    if (typeof SharedWorker === "undefined") {
      console.warn("[WorkerClient] SharedWorker not supported — falling back to SyncManager");
      const { default: SyncManager } = await import("@/app/lib/idb/SyncManager");
      const sm = SyncManager.getInstance();
      await sm.init();
      this._fallback = sm;
      return;
    }

    // ── Stale-download detection ──────────────────────────────────────────
    // Before connecting to the SharedWorker, check IDB for any rows stuck
    // in 'downloading' state. If found, wipe the cursor so the worker's
    // boot sync does a full fetch and picks up the real terminal status.
    // This must happen BEFORE the worker is connected so the wiped cursor
    // is what gets sent in the 'declare' message — not the stale one.
    try {
      const idbRows = await getAllDownloads("http");
      const hasStale = idbRows.some((r) => r.status === "downloading");
      if (hasStale) {
        await setCursor("downloads_cursor", new Date(0).toISOString());
      }
    } catch {
      // IDB unavailable — safe to continue
    }
    // ─────────────────────────────────────────────────────────────────────

    // Fetch the worker script to get its ETag (content hash).
    let workerName = "streamlift-sync";
    try {
      const probe = await fetch("/api/sync-worker", { method: "HEAD" });
      const etag = probe.headers.get("etag");
      if (etag) workerName = `streamlift-sync-${etag.replace(/"/g, "")}`;
    } catch {
      // If probe fails, use the default name — worker will still load
    }

    this.worker = new SharedWorker("/api/sync-worker", { name: workerName });
    this.port   = this.worker.port;

    this.port.onmessage = (ev: MessageEvent<WorkerToTabMessage>) => {
      void this.handleWorkerMessage(ev.data);
    };

    this.port.start();
    this.send({ type: "init", origin: window.location.origin });
  }

  // ─── Send ────────────────────────────────────────────────────────────────

  private send(msg: TabToWorkerMessage): void {
    if (!this.port) {
      // Port not yet established (init still in progress) — queue the message.
      // It will be sent once the port is ready and flushPending runs.
      if (msg.type !== "init") {
        this.pendingMessages.push(msg);
      }
      return;
    }
    if (!this.ready && msg.type !== "init") {
      this.pendingMessages.push(msg);
      return;
    }
    try { this.port.postMessage(msg); }
    catch (err) { console.warn("[WorkerClient] postMessage failed", err); }
  }

  private flushPending(): void {
    // Deduplicate tracking messages — only the last stopTracking/trackDownload matters
    const msgs = this.pendingMessages.splice(0);
    const lastTrackingIdx = msgs.reduce((last, msg, i) =>
      (msg.type === "trackDownload" || msg.type === "stopTracking") ? i : last, -1);
    const deduped = msgs.filter((msg, i) => {
      if (msg.type === "trackDownload" || msg.type === "stopTracking") {
        return i === lastTrackingIdx;
      }
      return true;
    });
    for (const msg of deduped) this.send(msg);
  }

  // ─── Handle messages from worker ─────────────────────────────────────────

  private async handleWorkerMessage(msg: WorkerToTabMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.ready = true;
        this.flushPending();
        break;

      case "networkStatus":
        this.networkSubs.forEach((cb) => cb(msg.status));
        break;

      case "progress":
        this.progressSubs.forEach((cb) => cb(msg.payload));
        break;

      case "workerStatus": {
        const subs = this.workerStatusSubs.get(msg.workerId);
        if (subs) subs.forEach((cb) => cb(msg.status));
        break;
      }

      case "saveCursor": {
        // Persist the cursor to IDB so the next worker restart resumes from here
        const CURSOR_MAP: Record<string, string> = {
          downloads: "downloads_cursor",
          torrents:  "torrents_cursor",
          workers:   "workers_cursor",
        };
        const key = CURSOR_MAP[msg.entity];
        if (key) void setCursor(key as any, msg.cursor);
        break;
      }

      case "data":
        await this.handleData(msg.entity, msg.rows, msg.runtimeStatus, msg.orphanIds);
        break;
    }
  }

  private async handleData(
    entity: SyncEntity,
    rows: Record<string, unknown>[],
    runtimeStatus?: Record<string, {
      online: boolean; ipAddress: string | null; lastHeartbeat: string | null;
    }>,
    orphanIds?: string[]   // IDs to remove from IDB (reconciliation from worker)
  ): Promise<void> {
    if (entity === "downloads" || entity === "torrents") {
      // Remove orphans first (externally deleted rows)
      if (orphanIds && orphanIds.length > 0) {
        const { deleteDownloadFromIDB } = await import("@/app/lib/idb/IDBStore");
        await Promise.all(orphanIds.map((id) => deleteDownloadFromIDB(id)));
      }
      if (rows.length > 0) {
        await upsertDownloads(rows as unknown as FileDownload[]);
      }
      const downloadType = entity === "downloads" ? "http" : "torrent";
      const idbRows = await getAllDownloads(downloadType);
      const subs = entity === "downloads" ? this.downloadSubs : this.torrentSubs;
      subs.forEach((cb) => cb(idbRows));

    } else if (entity === "workers") {
      if (orphanIds && orphanIds.length > 0) {
        const { deleteWorkerFromIDB } = await import("@/app/lib/idb/IDBStore");
        await Promise.all(orphanIds.map((id) => deleteWorkerFromIDB(id)));
      }
      if (rows.length > 0) {
        await upsertWorkers(rows as unknown as Worker[], runtimeStatus);
      }
      if (runtimeStatus) {
        await patchWorkersRuntime(runtimeStatus);
      }
      const idbWorkers = await getAllWorkers();
      this.workerSubs.forEach((cb) => cb(idbWorkers));
    }
  }

  // ─── Dependency registry helpers ─────────────────────────────────────────

  /**
   * Reads all per-entity IDB cursors AND current IDB IDs in parallel, then
   * sends a single "declare" message to the worker with the current needs set.
   *
   * Sending IDB IDs lets the worker detect orphans (server-deleted rows) on
   * the very first reconcile after boot — before broadcastIds is populated.
   * Multiple tabs reloading simultaneously will each send their IDB IDs; the
   * worker merges (unions) them over a 500 ms debounce window before running
   * one reconcile for all tabs.
   *
   * Called whenever needs changes (entity added or removed).
   */
  private async flushDeclare(): Promise<void> {
    const CURSOR_KEYS: Record<SyncEntity, string> = {
      downloads: "downloads_cursor",
      torrents:  "torrents_cursor",
      workers:   "workers_cursor",
    };

    // Only fetch data for entities we actually need.
    const needed = Array.from(this.needs) as SyncEntity[];

    const [cursorEntries, idbIdEntries] = await Promise.all([
      // Cursors — used to resume delta syncing from the right point
      Promise.all(
        needed.map(async (entity) => {
          const cursor = await getCursor(CURSOR_KEYS[entity] as any);
          return [entity, cursor] as const;
        })
      ),
      // IDB IDs — used by the worker to detect orphans on first reconcile
      Promise.all(
        needed.map(async (entity) => {
          let ids: string[];
          if (entity === "workers") {
            const rows = await getAllWorkers();
            ids = rows.map((r) => r.id);
          } else {
            const type = entity === "downloads" ? "http" : "torrent";
            const rows = await getAllDownloads(type);
            ids = rows.map((r) => r.id);
          }
          return [entity, ids] as const;
        })
      ),
    ]);

    const cursors: Partial<Record<SyncEntity, string>> = {};
    for (const [entity, cursor] of cursorEntries) {
      if (cursor) cursors[entity] = cursor;
    }

    const idbIds: Partial<Record<SyncEntity, string[]>> = {};
    for (const [entity, ids] of idbIdEntries) {
      idbIds[entity] = ids;
    }

    this.send({ type: "declare", needs: needed, cursors, idbIds });
  }

  // ─── Data subscribe / unsubscribe ─────────────────────────────────────────

  subscribe(entity: "downloads" | "torrents", cb: DownloadDataCallback): void;
  subscribe(entity: "workers", cb: WorkerDataCallback): void;
  subscribe(entity: SyncEntity, cb: DownloadDataCallback | WorkerDataCallback): void {
    if (this.isFallback) { this._fallback.subscribe(entity, cb); return; }

    if (entity === "downloads") {
      this.downloadSubs.add(cb as DownloadDataCallback);
      if (this.downloadSubs.size === 1) {
        this.needs.add("downloads");
        void this.flushDeclare();
        void this.emitFromIDB("downloads");
      }
    } else if (entity === "torrents") {
      this.torrentSubs.add(cb as DownloadDataCallback);
      if (this.torrentSubs.size === 1) {
        this.needs.add("torrents");
        void this.flushDeclare();
        void this.emitFromIDB("torrents");
      }
    } else if (entity === "workers") {
      this.workerSubs.add(cb as WorkerDataCallback);
      if (this.workerSubs.size === 1) {
        this.needs.add("workers");
        void this.flushDeclare();
        void this.emitFromIDB("workers");
      }
    }
  }

  unsubscribe(entity: "downloads" | "torrents", cb: DownloadDataCallback): void;
  unsubscribe(entity: "workers", cb: WorkerDataCallback): void;
  unsubscribe(entity: SyncEntity, cb: DownloadDataCallback | WorkerDataCallback): void {
    if (this.isFallback) { this._fallback.unsubscribe(entity, cb); return; }

    if (entity === "downloads") {
      this.downloadSubs.delete(cb as DownloadDataCallback);
      if (this.downloadSubs.size === 0) {
        this.needs.delete("downloads");
        void this.flushDeclare();
      }
    } else if (entity === "torrents") {
      this.torrentSubs.delete(cb as DownloadDataCallback);
      if (this.torrentSubs.size === 0) {
        this.needs.delete("torrents");
        void this.flushDeclare();
      }
    } else if (entity === "workers") {
      this.workerSubs.delete(cb as WorkerDataCallback);
      if (this.workerSubs.size === 0) {
        this.needs.delete("workers");
        void this.flushDeclare();
      }
    }
  }

  // ─── Progress subscribe ───────────────────────────────────────────────────

  subscribeProgress(cb: ProgressCallback): () => void {
    this.progressSubs.add(cb);
    return () => this.progressSubs.delete(cb);
  }

  // ─── Network subscribe ────────────────────────────────────────────────────

  subscribeNetwork(cb: NetworkCallback): () => void {
    if (this.isFallback) return this._fallback.subscribeNetwork(cb);
    this.networkSubs.add(cb);
    return () => this.networkSubs.delete(cb);
  }

  // ─── Worker status subscribe (replaces per-tab useWorkerStatus SSE) ───────

  subscribeWorkerStatus(workerId: string, cb: WorkerStatusCallback): () => void {
    if (this.isFallback) {
      // Fallback: poll the single worker status endpoint directly from the tab
      // This only runs when SharedWorker is not available
      let timer: ReturnType<typeof setInterval> | null = null;
      const poll = async () => {
        try {
          const res = await fetch(`/api/worker/${workerId}/status`);
          if (res.ok) {
            const data = await res.json();
            cb(data as WorkerStatusPayload);
          }
        } catch {}
      };
      void poll();
      timer = setInterval(poll, 10000);
      return () => { if (timer) clearInterval(timer); };
    }

    if (!this.workerStatusSubs.has(workerId)) {
      this.workerStatusSubs.set(workerId, new Set());
    }
    const subs = this.workerStatusSubs.get(workerId)!;
    subs.add(cb);

    if (subs.size === 1) {
      this.send({ type: "watchWorker", workerId });
    }

    return () => {
      subs.delete(cb);
      if (subs.size === 0) {
        this.workerStatusSubs.delete(workerId);
        this.send({ type: "unwatchWorker", workerId });
      }
    };
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  syncNow(entity: SyncEntity): void {
    if (this.isFallback) { this._fallback.syncNow(entity); return; }
    this.send({ type: "syncNow", entity });
  }

  /**
   * Reset the worker's in-memory cursor for an entity to null, then
   * also wipe the IDB cursor so restarts resume from the beginning.
   * The worker will immediately run a full (non-delta) sync.
   */
  async resetCursorAndSync(entity: SyncEntity): Promise<void> {
    if (this.isFallback) { this._fallback.syncNow(entity); return; }

    // Wipe IDB cursor first so if the worker restarts it also starts clean
    const CURSOR_KEYS: Record<SyncEntity, string> = {
      downloads: "downloads_cursor",
      torrents:  "torrents_cursor",
      workers:   "workers_cursor",
    };
    await setCursor(CURSOR_KEYS[entity] as any, new Date(0).toISOString());

    // If the worker isn't ready yet, wait for it so resetCursor is the LAST
    // thing in the queue — after declare (which may set an old cursor).
    if (!this.ready) {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (this.ready) { clearInterval(check); resolve(); }
        }, 20);
      });
    }

    // Tell the running worker to drop its in-memory cursor and force a sync
    this.send({ type: "resetCursor", entity });
  }

  trackDownload(
    downloadId: string,
    workerId: string | null,
    downloadType: "express" | "worker"
  ): void {
    if (this.isFallback) return;
    this.send({ type: "trackDownload", downloadId, workerId, downloadType });
  }

  stopTracking(): void {
    if (this.isFallback) return;
    this.send({ type: "stopTracking" });
  }

  // ─── IDB seed helpers ─────────────────────────────────────────────────────

  private async emitFromIDB(entity: SyncEntity): Promise<void> {
    if (entity === "downloads") {
      const rows = await getAllDownloads("http");
      this.downloadSubs.forEach((cb) => cb(rows));
    } else if (entity === "torrents") {
      const rows = await getAllDownloads("torrent");
      this.torrentSubs.forEach((cb) => cb(rows));
    } else if (entity === "workers") {
      const rows = await getAllWorkers();
      this.workerSubs.forEach((cb) => cb(rows));
    }
  }

  // ─── Delete helpers ───────────────────────────────────────────────────────

  async deleteDownload(id: string): Promise<void> {
    await deleteDownloadFromIDB(id);
    await this.emitFromIDB("downloads");
    await this.emitFromIDB("torrents");
  }

  async deleteWorker(id: string): Promise<void> {
    await deleteWorkerFromIDB(id);
    await this.emitFromIDB("workers");
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────

  static reset(): void {
    const inst = WorkerClient.instance;
    if (inst?.port) { try { inst.port.close(); } catch {} }
    WorkerClient.instance = null;
  }
}

export default WorkerClient;
export type { WorkerStatusPayload };

// ─── HMR cleanup ─────────────────────────────────────────────────────────────
if (typeof module !== "undefined" && (module as any).hot) {
  (module as any).hot.dispose(() => { WorkerClient.reset(); });
}
