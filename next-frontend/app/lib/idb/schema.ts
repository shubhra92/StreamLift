/**
 * IndexedDB schema definition.
 *
 * Database: "streamlift-db"  version: 3
 *
 * Stores:
 *  - fileDownloads  — local replica of the fileDownloads table
 *  - workers        — local replica of the workers table
 *  - syncMeta       — cursor timestamps + guest guard value
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { FileDownload, Worker } from "@/app/db/schema";

// ─── IDB row types ────────────────────────────────────────────────────────────

/** FileDownload row as stored in IDB (Date fields serialised as strings by IDB) */
export type IDBFileDownload = Omit<FileDownload, "createdAt" | "updatedAt"> & {
  createdAt: string | null;
  updatedAt: string | null;
  /** ISO timestamp of when this row was last written to IDB */
  _syncedAt: string;
};

/** Worker row as stored in IDB (includes runtime fields so seeded data is correct) */
export type IDBWorker = Omit<Worker, "createdAt" | "updatedAt"> & {
  createdAt: string | null;
  updatedAt: string | null;
  /** ISO timestamp of when this row was last written to IDB */
  _syncedAt: string;
  /** Runtime fields from workerStore — persisted so page seed is correct */
  online: boolean;
  ipAddress: string | null;
  lastHeartbeat: string | null;
};

// ─── Sync meta keys ───────────────────────────────────────────────────────────

export type SyncMetaKey =
  | "downloads_cursor"   // max updatedAt seen for http downloads (delta query)
  | "torrents_cursor"    // max updatedAt seen for torrent downloads (delta query)
  | "workers_cursor"     // max updatedAt seen for workers (delta query)
  | "downloads_synced_at" // wall-clock of last completed downloads sync
  | "torrents_synced_at"  // wall-clock of last completed torrents sync
  | "workers_synced_at"   // wall-clock of last completed workers sync
  | "guest_id";           // guards against guest rotation

// ─── DBSchema ─────────────────────────────────────────────────────────────────

export interface StreamLiftDB extends DBSchema {
  fileDownloads: {
    key: string;           // id (uuid)
    value: IDBFileDownload;
    indexes: {
      by_downloadType: string;          // downloadType
      by_status: string;                // status
      by_updatedAt: string;             // updatedAt  (for cursor queries)
    };
  };
  workers: {
    key: string;           // id (uuid)
    value: IDBWorker;
    indexes: {
      by_updatedAt: string;
    };
  };
  syncMeta: {
    key: SyncMetaKey;
    value: string;         // ISO timestamp string or guestId string
  };
}

// ─── DB singleton ─────────────────────────────────────────────────────────────

let _db: IDBPDatabase<StreamLiftDB> | null = null;

export async function getDB(): Promise<IDBPDatabase<StreamLiftDB>> {
  if (_db) return _db;

  _db = await openDB<StreamLiftDB>("streamlift-db", 3, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
      // ── fileDownloads store ──────────────────────────────────────────────
      const dlStore = db.createObjectStore("fileDownloads", { keyPath: "id" });
      dlStore.createIndex("by_downloadType", "downloadType");
      dlStore.createIndex("by_status", "status");
      dlStore.createIndex("by_updatedAt", "updatedAt");

      // ── workers store ────────────────────────────────────────────────────
      const wStore = db.createObjectStore("workers", { keyPath: "id" });
      wStore.createIndex("by_updatedAt", "updatedAt");

        // ── syncMeta store ─────────────────────────────────────────────────
        db.createObjectStore("syncMeta");
      }
      const rawDb = db as unknown as IDBDatabase;
      if (oldVersion < 3 && rawDb.objectStoreNames.contains("workerFileTransfers")) {
        rawDb.deleteObjectStore("workerFileTransfers");
      }
    },
  });

  return _db;
}
