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

  /** Counts syncs per entity — reconciliation runs every RECONCILE_EVERY syncs */
  private syncCount: Record<string, number> = {};
  private static readonly RECONCILE_EVERY = 5;

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

    // Fetch the worker script to get its ETag (content hash).
    // We include the hash in the worker name so Chrome loads a fresh worker
    // whenever sync-worker.js changes — no manual version bumping needed.
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
    if (!this.port) return;
    if (!this.ready && msg.type !== "init") {
      this.pendingMessages.push(msg);
      return;
    }
    try { this.port.postMessage(msg); }
    catch (err) { console.warn("[WorkerClient] postMessage failed", err); }
  }

  private flushPending(): void {
    const msgs = this.pendingMessages.splice(0);
    for (const msg of msgs) this.send(msg);
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
   * Reads all per-entity IDB cursors in parallel, then sends a single
   * "declare" message to the worker with the current needs set.
   * Called whenever needs changes (entity added or removed).
   */
  private async flushDeclare(): Promise<void> {
    const CURSOR_KEYS: Record<SyncEntity, string> = {
      downloads: "downloads_cursor",
      torrents:  "torrents_cursor",
      workers:   "workers_cursor",
    };

    // Only fetch cursors for entities we actually need — no point sending
    // a cursor for an entity we're declaring as unneeded.
    const needed = Array.from(this.needs) as SyncEntity[];
    const cursorEntries = await Promise.all(
      needed.map(async (entity) => {
        const cursor = await getCursor(CURSOR_KEYS[entity] as any);
        return [entity, cursor] as const;
      })
    );

    const cursors: Partial<Record<SyncEntity, string>> = {};
    for (const [entity, cursor] of cursorEntries) {
      if (cursor) cursors[entity] = cursor;
    }

    this.send({ type: "declare", needs: needed, cursors });
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
