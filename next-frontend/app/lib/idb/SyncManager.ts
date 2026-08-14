/**
 * SyncManager — singleton that owns all delta-sync logic.
 *
 * ── Multi-tab coordination ────────────────────────────────────────────────────
 * Uses localStorage + BroadcastChannel for leader election. This approach is
 * reliable across HMR, dev mode, and all modern browsers.
 *
 * Leader election (localStorage heartbeat):
 *  - Each tab has a unique tabId (random, in-memory)
 *  - The leader writes { tabId, ts } to localStorage every LEADER_HEARTBEAT_MS
 *  - On init and on storage events, each tab checks:
 *      - If no heartbeat exists → claim leadership
 *      - If heartbeat is stale (> LEADER_STALE_MS) → claim leadership
 *      - If heartbeat is fresh and tabId != mine → I am a follower
 *  - When the leader tab closes, its heartbeat stops. After LEADER_STALE_MS
 *    one of the follower tabs claims leadership and starts syncing.
 *
 * BroadcastChannel (when available):
 *  - Leader broadcasts { entity, syncedAt } after every sync
 *  - Followers receive it and re-read IDB to update their UI
 *  - Fallback: followers rely on shared IDB — storage events trigger re-reads
 *
 * Fallback (BroadcastChannel unavailable):
 *  - Leader election still works via localStorage
 *  - Followers detect new data via the storage event on the heartbeat key
 *    and re-emit from IDB
 *
 * ── Single-tab ───────────────────────────────────────────────────────────────
 *  - Immediately claims leadership, no contention
 *
 * ── Smart boot sync ──────────────────────────────────────────────────────────
 *  - On subscribe, checks IDB age (workers_synced_at etc.)
 *  - Only fetches if data is stale (age >= interval)
 *  - Otherwise emits from IDB immediately, no network call
 */

import { runGuestGuard } from "./guestGuard";
import {
  getCursor,
  setCursor,
  upsertDownloads,
  upsertWorkers,
  patchWorkersRuntime,
  getAllDownloads,
  getAllWorkers,
} from "./IDBStore";
import type { SyncMetaKey } from "./schema";
import type { IDBFileDownload, IDBWorker } from "./schema";

// ─── Entity types ─────────────────────────────────────────────────────────────

export type SyncEntity = "downloads" | "torrents" | "workers";

// ─── Callbacks ────────────────────────────────────────────────────────────────

type DownloadsCallback = (rows: IDBFileDownload[]) => void;
type TorrentsCallback  = (rows: IDBFileDownload[]) => void;
type WorkersCallback   = (rows: IDBWorker[]) => void;

type EntityCallbackMap = {
  downloads: DownloadsCallback;
  torrents:  TorrentsCallback;
  workers:   WorkersCallback;
};

// ─── BroadcastChannel message ─────────────────────────────────────────────────

interface SyncBroadcast {
  type: "sync-complete";
  entity: SyncEntity;
  syncedAt: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const INTERVALS: Record<SyncEntity, number> = {
  downloads: 30_000,
  torrents:  30_000,
  workers:   15_000,
};

const CURSOR_KEY: Record<SyncEntity, SyncMetaKey> = {
  downloads: "downloads_cursor",
  torrents:  "torrents_cursor",
  workers:   "workers_cursor",
};

const SYNCED_AT_KEY: Record<SyncEntity, SyncMetaKey> = {
  downloads: "downloads_synced_at",
  torrents:  "torrents_synced_at",
  workers:   "workers_synced_at",
};

/** localStorage key for leader heartbeat */
const LEADER_KEY = "streamlift-sync-leader";
/** How often the leader writes its heartbeat (ms) */
const LEADER_HEARTBEAT_MS = 3_000;
/** How old a heartbeat can be before another tab claims leadership (ms) */
const LEADER_STALE_MS = 8_000;

// ─── Online / offline ─────────────────────────────────────────────────────────

export type NetworkStatus = "online" | "offline";

// ─── Leader heartbeat shape ───────────────────────────────────────────────────

interface LeaderRecord {
  tabId: string;
  ts: number; // Date.now()
}

// ─── SyncManager ─────────────────────────────────────────────────────────────

class SyncManager {
  private static instance: SyncManager | null = null;

  /** Unique id for this tab — in-memory, not persisted */
  private readonly tabId = Math.random().toString(36).slice(2);

  private initialized = false;
  private networkStatus: NetworkStatus = "online";
  private isLeader = false;

  private channel: BroadcastChannel | null = null;
  private leaderHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leaderCheckTimer: ReturnType<typeof setInterval> | null = null;

  private subscribers: {
    downloads: Set<DownloadsCallback>;
    torrents:  Set<TorrentsCallback>;
    workers:   Set<WorkersCallback>;
  } = {
    downloads: new Set(),
    torrents:  new Set(),
    workers:   new Set(),
  };

  private intervals: Partial<Record<SyncEntity, ReturnType<typeof setInterval>>> = {};
  private debounceTimers: Partial<Record<SyncEntity, ReturnType<typeof setTimeout>>> = {};
  private syncing: Partial<Record<SyncEntity, boolean>> = {};
  private networkSubscribers: Set<(status: NetworkStatus) => void> = new Set();

  private constructor() {}

  static getInstance(): SyncManager {
    if (!SyncManager.instance) {
      SyncManager.instance = new SyncManager();
    }
    return SyncManager.instance;
  }

  // ─── Init ──────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    await runGuestGuard();

    if (typeof window === "undefined") return;

    // Online/offline
    this.networkStatus = navigator.onLine ? "online" : "offline";
    window.addEventListener("online",  () => this.handleNetworkChange("online"));
    window.addEventListener("offline", () => this.handleNetworkChange("offline"));

    // BroadcastChannel (best-effort)
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel("streamlift-sync");
      this.channel.onmessage = (ev: MessageEvent<SyncBroadcast>) => {
        if (ev.data?.type === "sync-complete") {
          void this.emitFromIDB(ev.data.entity);
        }
      };
    }

    // Listen for localStorage changes from other tabs
    window.addEventListener("storage", (ev) => {
      if (ev.key === LEADER_KEY) {
        this.evaluateLeadership();
      }
    });

    // Claim or yield leadership
    this.evaluateLeadership();

    // Periodically re-check in case the leader tab closed
    this.leaderCheckTimer = setInterval(() => {
      this.evaluateLeadership();
    }, LEADER_STALE_MS);
  }

  // ─── Leader election ───────────────────────────────────────────────────────

  private readLeaderRecord(): LeaderRecord | null {
    try {
      const raw = localStorage.getItem(LEADER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private writeLeaderHeartbeat(): void {
    try {
      const record: LeaderRecord = { tabId: this.tabId, ts: Date.now() };
      localStorage.setItem(LEADER_KEY, JSON.stringify(record));
    } catch {}
  }

  private claimLeadership(): void {
    if (this.isLeader) return; // already leader

    this.isLeader = true;
    console.info(`[SyncManager] Tab ${this.tabId.slice(0, 6)} became sync leader`);

    this.writeLeaderHeartbeat();

    // Keep heartbeat alive
    this.leaderHeartbeatTimer = setInterval(() => {
      this.writeLeaderHeartbeat();
    }, LEADER_HEARTBEAT_MS);

    // Start intervals for any entities that already have subscribers
    for (const entity of (["downloads", "torrents", "workers"] as SyncEntity[])) {
      if (this.subscribers[entity].size > 0 && !this.intervals[entity]) {
        this.startInterval(entity);
      }
    }
  }

  private yieldLeadership(): void {
    if (!this.isLeader) return;
    this.isLeader = false;
    if (this.leaderHeartbeatTimer) {
      clearInterval(this.leaderHeartbeatTimer);
      this.leaderHeartbeatTimer = null;
    }
    this.stopAllIntervals();
  }

  private evaluateLeadership(): void {
    const record = this.readLeaderRecord();

    if (!record) {
      // No leader exists → claim it
      this.claimLeadership();
      return;
    }

    const ageMs = Date.now() - record.ts;

    if (record.tabId === this.tabId) {
      // We are the current leader — refresh heartbeat
      this.writeLeaderHeartbeat();
      if (!this.isLeader) this.claimLeadership();
      return;
    }

    if (ageMs > LEADER_STALE_MS) {
      // Leader heartbeat is stale — that tab likely closed → claim leadership
      console.info(`[SyncManager] Leader heartbeat stale (${ageMs}ms) — claiming leadership`);
      this.claimLeadership();
      return;
    }

    // Another tab is the active leader → be a follower
    if (this.isLeader) {
      this.yieldLeadership();
    }
  }

  // ─── Network ──────────────────────────────────────────────────────────────

  private handleNetworkChange(status: NetworkStatus): void {
    const wasOffline = this.networkStatus === "offline";
    this.networkStatus = status;
    this.networkSubscribers.forEach((cb) => cb(status));

    if (wasOffline && status === "online" && this.isLeader) {
      for (const entity of (["downloads", "torrents", "workers"] as SyncEntity[])) {
        if (this.subscribers[entity].size > 0) this.syncNow(entity);
      }
    }
  }

  get isOnline(): boolean {
    return this.networkStatus === "online";
  }

  subscribeNetwork(cb: (status: NetworkStatus) => void): () => void {
    this.networkSubscribers.add(cb);
    return () => this.networkSubscribers.delete(cb);
  }

  // ─── Subscribe / unsubscribe ──────────────────────────────────────────────

  subscribe<E extends SyncEntity>(entity: E, cb: EntityCallbackMap[E]): void {
    const set = this.subscribers[entity] as Set<EntityCallbackMap[E]>;
    set.add(cb);

    if (set.size === 1) {
      if (this.isLeader) {
        // Leader — start interval with smart boot sync
        this.startInterval(entity);
      } else {
        // Follower — serve from IDB immediately, no network call
        void this.emitFromIDB(entity);
      }
    }
  }

  unsubscribe<E extends SyncEntity>(entity: E, cb: EntityCallbackMap[E]): void {
    const set = this.subscribers[entity] as Set<EntityCallbackMap[E]>;
    set.delete(cb);
    if (set.size === 0) this.stopInterval(entity);
  }

  // ─── Interval management ─────────────────────────────────────────────────

  private startInterval(entity: SyncEntity): void {
    if (this.intervals[entity]) return;
    void this.bootSyncIfStale(entity);
    this.intervals[entity] = setInterval(() => {
      void this.runSync(entity);
    }, INTERVALS[entity]);
  }

  /**
   * Only fetch if IDB data is stale. Otherwise emit from IDB instantly.
   * Uses wall-clock *_synced_at key, not the delta cursor.
   */
  private async bootSyncIfStale(entity: SyncEntity): Promise<void> {
    const lastSyncedAt = await getCursor(SYNCED_AT_KEY[entity]);

    if (!lastSyncedAt) {
      void this.runSync(entity);
      return;
    }

    const ageMs = Date.now() - new Date(lastSyncedAt).getTime();
    if (ageMs >= INTERVALS[entity]) {
      void this.runSync(entity);
    } else {
      await this.emitFromIDB(entity);
    }
  }

  private stopInterval(entity: SyncEntity): void {
    const handle = this.intervals[entity];
    if (handle) {
      clearInterval(handle);
      delete this.intervals[entity];
    }
  }

  stopAllIntervals(): void {
    for (const entity of Object.keys(this.intervals) as SyncEntity[]) {
      const handle = this.intervals[entity];
      if (handle) clearInterval(handle);
    }
    this.intervals = {};
  }

  // ─── syncNow ─────────────────────────────────────────────────────────────

  syncNow(entity: SyncEntity): void {
    const existing = this.debounceTimers[entity];
    if (existing) clearTimeout(existing);

    this.debounceTimers[entity] = setTimeout(() => {
      if (this.isLeader) {
        void this.runSync(entity);
      } else {
        // Follower: serve from IDB — leader will broadcast shortly
        void this.emitFromIDB(entity);
      }
    }, 50);
  }

  // ─── Core sync ────────────────────────────────────────────────────────────

  private async runSync(entity: SyncEntity): Promise<void> {
    if (this.syncing[entity]) return;
    if (!this.isOnline) {
      await this.emitFromIDB(entity);
      return;
    }

    this.syncing[entity] = true;
    try {
      const syncedAt = await this.fetchAndMerge(entity);
      if (syncedAt) {
        // Notify follower tabs — they re-read IDB and update their UI
        this.broadcast(entity, syncedAt);
      }
    } catch (err) {
      console.warn(`[SyncManager] sync failed for ${entity}:`, err);
      await this.emitFromIDB(entity);
    } finally {
      this.syncing[entity] = false;
    }
  }

  private async fetchAndMerge(entity: SyncEntity): Promise<string | undefined> {
    const cursor = await getCursor(CURSOR_KEY[entity]);
    const now = new Date().toISOString();

    if (entity === "downloads") {
      const { getDownloads } = await import("@/app/actions/downloads");
      const result = await getDownloads(cursor);
      await upsertDownloads(result.data);
      if (result.data.length > 0 || !cursor) {
        await setCursor(CURSOR_KEY[entity], result.syncedAt);
      }
      await setCursor(SYNCED_AT_KEY[entity], now);
      await this.emitFromIDB("downloads");
      return now;

    } else if (entity === "torrents") {
      const { getTorrentDownloads } = await import("@/app/actions/torrents");
      const result = await getTorrentDownloads(cursor);
      await upsertDownloads(result.data);
      if (result.data.length > 0 || !cursor) {
        await setCursor(CURSOR_KEY[entity], result.syncedAt);
      }
      await setCursor(SYNCED_AT_KEY[entity], now);
      await this.emitFromIDB("torrents");
      return now;

    } else if (entity === "workers") {
      const since = cursor ? `?since=${encodeURIComponent(cursor)}` : "";
      const res = await fetch(`/api/worker/list${since}`, { credentials: "include" });

      if (!res.ok) {
        await this.emitFromIDB("workers");
        return undefined;
      }

      const result: {
        data: Record<string, unknown>[];
        syncedAt: string;
        runtimeStatus: Record<string, {
          online:        boolean;
          lastHeartbeat: string | null;
          pinggyUrl:     string | null;
          ipAddress:     string | null;
        }>;
      } = await res.json();

      if (result.data.length > 0) {
        await upsertWorkers(
          result.data as Parameters<typeof upsertWorkers>[0],
          result.runtimeStatus as any
        );
        await setCursor(CURSOR_KEY[entity], result.syncedAt);
      } else if (!cursor) {
        await setCursor(CURSOR_KEY[entity], result.syncedAt);
      }

      await patchWorkersRuntime(result.runtimeStatus as any);
      await setCursor(SYNCED_AT_KEY[entity], now);

      const idbWorkers = await getAllWorkers();
      this.emit("workers", idbWorkers as IDBWorker[]);
      return now;
    }
  }

  // ─── Broadcast ────────────────────────────────────────────────────────────

  private broadcast(entity: SyncEntity, syncedAt: string): void {
    if (!this.channel) return;
    try {
      const msg: SyncBroadcast = { type: "sync-complete", entity, syncedAt };
      this.channel.postMessage(msg);
    } catch {}
  }

  // ─── Emit from IDB ────────────────────────────────────────────────────────

  private async emitFromIDB(entity: SyncEntity): Promise<void> {
    if (entity === "downloads") {
      const rows = await getAllDownloads("http");
      this.emit("downloads", rows);
    } else if (entity === "torrents") {
      const rows = await getAllDownloads("torrent");
      this.emit("torrents", rows);
    } else if (entity === "workers") {
      const rows = await getAllWorkers();
      this.emit("workers", rows);
    }
  }

  private emit<E extends SyncEntity>(
    entity: E,
    data: Parameters<EntityCallbackMap[E]>[0]
  ): void {
    (this.subscribers[entity] as Set<(d: typeof data) => void>).forEach((cb) =>
      cb(data)
    );
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────

  static reset(): void {
    const inst = SyncManager.instance;
    if (inst) {
      inst.stopAllIntervals();
      inst.channel?.close();
      if (inst.leaderHeartbeatTimer) clearInterval(inst.leaderHeartbeatTimer);
      if (inst.leaderCheckTimer) clearInterval(inst.leaderCheckTimer);
      // Release the leader heartbeat so another tab can claim immediately
      if (inst.isLeader) {
        try { localStorage.removeItem(LEADER_KEY); } catch {}
      }
    }
    SyncManager.instance = null;
  }
}

export default SyncManager;

// ─── HMR cleanup (dev only) ───────────────────────────────────────────────────
if (typeof module !== "undefined" && (module as any).hot) {
  (module as any).hot.dispose(() => {
    SyncManager.reset();
  });
}
