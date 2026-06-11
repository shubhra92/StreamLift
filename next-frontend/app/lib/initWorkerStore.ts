import { db } from "../db";
import { workers } from "../db/schema";
import { workerStore, initializeWorkerState, startOfflineChecker } from "./workerStore";

let initialized = false;

export async function initWorkerStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    const allWorkers = await db.select().from(workers);
    for (const worker of allWorkers) {
      if (!workerStore.has(worker.id)) {
        workerStore.set(worker.id, initializeWorkerState(worker.id));
      }
    }
    startOfflineChecker();
    console.log(`[WorkerStore] Initialized with ${allWorkers.length} workers`);
  } catch (err) {
    console.error("[WorkerStore] Failed to initialize:", err);
    initialized = false; // allow retry
  }
}
