/**
 * Public barrel export for the IDB layer.
 * Import from here rather than individual files where convenient.
 */

export { getDB } from "./schema";
export type { IDBFileDownload, IDBWorker, SyncMetaKey, StreamLiftDB } from "./schema";

export {
  getAllDownloads,
  getAllWorkers,
  upsertDownloads,
  upsertWorkers,
  patchWorkersRuntime,
  deleteDownloadFromIDB,
  deleteWorkerFromIDB,
  getCursor,
  setCursor,
  clearAllIDB,
  reconcileDownloads,
  reconcileWorkers,
} from "./IDBStore";

export { runGuestGuard, resetGuestGuard } from "./guestGuard";

export { default as SyncManager } from "./SyncManager";
export type { SyncEntity, NetworkStatus } from "./SyncManager";
