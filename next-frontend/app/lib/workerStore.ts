/**
 * workerStore.ts — legacy type definitions kept for backward compatibility.
 *
 * The in-memory Map and offline checker have been removed.
 * Online status is now derived from last_heartbeat in the DB.
 * Live metrics and task progress stream directly from the worker's own SSE endpoint.
 */

export interface WorkerMetrics {
  cpuUsage:      number;  // percentage 0–100
  ramUsage:      number;  // percentage 0–100
  downloadSpeed: number;  // bytes per second
  uploadSpeed:   number;  // bytes per second
  timestamp:     string;  // ISO string
}

export interface WorkerLog {
  timestamp: string;
  level:     "info" | "warning" | "error" | "debug";
  message:   string;
}

export interface WorkerTask {
  downloadId: string;
  fileName:   string;
  status:     "pending" | "downloading" | "uploading" | "completed" | "failed";
  progress:   number;   // 0–100
  startedAt:  string;
}

export interface WorkerState {
  workerId:      string;
  online:        boolean;
  lastHeartbeat: string | null;
  pinggyUrl:     string | null;
  version:       string;
}
