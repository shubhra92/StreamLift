/**
 * Message protocol between tabs and the SharedWorker.
 * Single source of truth for all message shapes.
 */

// ─── Tab → Worker ─────────────────────────────────────────────────────────────

export type SyncEntity = "downloads" | "torrents" | "workers";

export type TabToWorkerMessage =
  | { type: "init"; origin?: string }
  /**
   * Replaces the old subscribe/unsubscribe pair.
   * The tab sends its FULL current set of needed entities whenever it changes.
   * The worker replaces that tab's slot and recomputes the union of all tabs'
   * needs — starting/stopping intervals accordingly.
   * cursors: per-entity IDB cursors so the worker can resume from the right point.
   */
  | {
      type: "declare";
      needs: SyncEntity[];
      cursors: Partial<Record<SyncEntity, string>>;
      /**
       * Current IDB IDs for each needed entity — sent on boot so the worker
       * can detect orphans (server-deleted rows) on the very first reconcile,
       * even before broadcastIds has been populated from a prior sync.
       */
      idbIds?: Partial<Record<SyncEntity, string[]>>;
    }
  | { type: "syncNow";       entity: SyncEntity }
  | { type: "resetCursor";   entity: SyncEntity }
  | {
      type: "trackDownload";
      downloadId: string;
      workerId: string | null;
      downloadType: "express" | "worker";
    }
  | { type: "stopTracking" }
  /** Open a shared SSE stream for worker detail status */
  | { type: "watchWorker";   workerId: string }
  /** Release interest in a worker's status stream */
  | { type: "unwatchWorker"; workerId: string };

// ─── Worker → Tab ─────────────────────────────────────────────────────────────

export interface ProgressPayload {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  percentFixed2: string | null;
  done: boolean;
  error?: string;
}

export interface WorkerStatusPayload {
  online: boolean;
  ipAddress: string | null;
  lastHeartbeat: string | null;
  metrics: unknown | null;
  currentTask: unknown | null;
  logs: unknown[];
  version: string;
}

export type WorkerToTabMessage =
  | {
      type: "data";
      entity: SyncEntity;
      rows: Record<string, unknown>[];
      runtimeStatus?: Record<string, {
        online: boolean;
        ipAddress: string | null;
        lastHeartbeat: string | null;
      }>;
      /** IDs present in IDB but deleted on server — tabs remove these */
      orphanIds?: string[];
    }
  | { type: "progress";      payload: ProgressPayload }
  | { type: "workerStatus";  workerId: string; status: WorkerStatusPayload }
  | { type: "networkStatus"; status: "online" | "offline" }
  /** Worker tells tabs to persist the new cursor to IDB */
  | { type: "saveCursor";    entity: SyncEntity; cursor: string }
  | { type: "ready" };
