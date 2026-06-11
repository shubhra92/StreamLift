export interface WorkerMetrics {
  cpuUsage: number;       // percentage 0-100
  ramUsage: number;       // percentage 0-100
  downloadSpeed: number;  // bytes per second
  uploadSpeed: number;    // bytes per second
  timestamp: string;      // ISO string
}

export interface WorkerLog {
  timestamp: string;      // ISO string
  level: "info" | "warning" | "error" | "debug";
  message: string;
}

export interface WorkerTask {
  downloadId: string;
  fileName: string;
  status: "pending" | "downloading" | "uploading" | "completed" | "failed";
  progress: number;       // percentage 0-100
  startedAt: string;      // ISO string
}

export interface WorkerState {
  workerId: string;
  online: boolean;
  ipAddress: string | null;
  lastHeartbeat: string | null; // ISO string
  metrics: WorkerMetrics | null;
  logs: WorkerLog[];            // max 10 entries (circular buffer)
  currentTask: WorkerTask | null;
  version: string;
}

// Singleton in-memory store
export const workerStore = new Map<string, WorkerState>();

export function initializeWorkerState(workerId: string): WorkerState {
  return {
    workerId,
    online: false,
    ipAddress: null,
    lastHeartbeat: null,
    metrics: null,
    logs: [],
    currentTask: null,
    version: "1.0.0",
  };
}

export function addWorkerLog(workerId: string, log: WorkerLog): void {
  const state = workerStore.get(workerId);
  if (!state) return;
  state.logs.push(log);
  if (state.logs.length > 10) {
    state.logs.shift(); // remove oldest
  }
}

export function updateWorkerMetrics(workerId: string, metrics: WorkerMetrics): void {
  const state = workerStore.get(workerId);
  if (state) state.metrics = metrics;
}

export function markWorkerOnline(workerId: string, ipAddress: string, version?: string): void {
  const state = workerStore.get(workerId);
  if (state) {
    state.online = true;
    state.ipAddress = ipAddress;
    state.lastHeartbeat = new Date().toISOString();
    if (version) state.version = version;
  }
}

export function markWorkerOffline(workerId: string): void {
  const state = workerStore.get(workerId);
  if (state) state.online = false;
}

export function updateWorkerHeartbeat(workerId: string): void {
  const state = workerStore.get(workerId);
  if (state) {
    state.online = true;
    state.lastHeartbeat = new Date().toISOString();
  }
}

const OFFLINE_TIMEOUT_MS = 30_000; // 30 seconds

let offlineCheckerStarted = false;

export function startOfflineChecker(): void {
  if (offlineCheckerStarted) return;
  offlineCheckerStarted = true;

  setInterval(() => {
    const now = Date.now();
    for (const [workerId, state] of workerStore.entries()) {
      if (!state.online || !state.lastHeartbeat) continue;
      const elapsed = now - new Date(state.lastHeartbeat).getTime();
      if (elapsed > OFFLINE_TIMEOUT_MS) {
        markWorkerOffline(workerId);
        addWorkerLog(workerId, {
          timestamp: new Date().toISOString(),
          level: "warning",
          message: "Worker marked offline due to heartbeat timeout",
        });
      }
    }
  }, 10_000);
}
