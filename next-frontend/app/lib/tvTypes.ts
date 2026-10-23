/** Shared request/response types for the Android TV pairing + catalog API. */

export type TvMediaKind = "video" | "audio";

export interface TvCatalogFile {
  /** Stable key: `workerId:downloadId:fileIndex`. */
  key: string;
  downloadId: string;
  fileIndex: number;
  /** Raw filename on the worker. */
  name: string;
  /** Friendly download name when the worker's filename is generic. */
  downloadName: string;
  size: number;
  kind: TvMediaKind;
  addedAt: string | null;
  /** Worker thumbnail URL; the TV should send X-Pinggy-No-Screen with it. */
  thumbnailUrl: string | null;
}

export interface TvCatalogWorker {
  id: string;
  name: string;
  countryCode: string | null;
  online: boolean;
  lastHeartbeat: string | null;
}

export interface TvCatalogGroup {
  worker: TvCatalogWorker;
  files: TvCatalogFile[];
}

export interface TvCatalogPayload {
  generatedAt: string;
  groups: TvCatalogGroup[];
  unreachableWorkers: Array<{ workerId: string; name: string; message: string }>;
  totals: { workers: number; files: number };
}

export interface TvDeviceSummary {
  id: string;
  name: string;
  model: string | null;
  appVersion: string | null;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string | null;
}

export interface TvPairStartRequest {
  deviceSecret: string;
  deviceName?: string;
  model?: string;
  appVersion?: string;
}

export interface TvPairStartResponse {
  success: true;
  code: string;
  expiresAt: string;
  /** Milliseconds until expiry, so the TV can count down without clock parsing. */
  expiresInMs: number;
  pollIntervalMs: number;
  serverTime: string;
}

export interface TvPairPollResponse {
  success: boolean;
  status: "pending" | "approved" | "denied" | "expired" | "unknown";
  expiresAt?: string;
  deviceToken?: string;
  device?: { id: string; name: string };
  message?: string;
}
