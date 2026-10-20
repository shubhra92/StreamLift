import type { WorkerLocalFile } from "@/app/lib/workerConnection";
import type { IDBWorker } from "@/app/lib/idb/schema";

export interface WatchFile extends WorkerLocalFile {
  kind: "video" | "audio";
  downloadId: string;
  downloadName: string;
}

export interface WatchGroup {
  worker: IDBWorker;
  files: WatchFile[];
}
