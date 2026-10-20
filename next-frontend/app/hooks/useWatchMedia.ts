"use client";

import { useEffect, useMemo, useState } from "react";
import { useAllDownloads } from "./useAllDownloads";
import { useWorkers } from "./useWorkers";
import { getWorkerLocalFiles, type WorkerLocalFile } from "../lib/workerConnection";
import { getMediaKind } from "../lib/media";
import type { WatchFile, WatchGroup } from "../components/watch/types";

/** The worker bounds `/downloads/files` to 100 ids per request. */
const ID_BATCH_SIZE = 100;

/**
 * Collect playable media from every online worker that stores downloads
 * locally, grouped by worker. Only files the worker still has on disk are
 * included (the worker verifies its completed-files manifest).
 */
export function useWatchMedia() {
  const { downloads, networkStatus } = useAllDownloads();
  const { workers } = useWorkers();

  const [filesByWorker, setFilesByWorker] = useState<Record<string, WatchFile[]>>({});
  const [loading, setLoading] = useState(true);

  // Re-fetch when completed worker downloads or online local workers change.
  const completedKey = downloads
    .filter((download) => download.status === "completed" && !!download.workerId)
    .map((download) => `${download.id}:${download.workerId}:${download.updatedAt ?? ""}`)
    .sort()
    .join("|");

  const onlineLocalKey = workers
    .filter((worker) => worker.online && worker.downloadLocation === "local")
    .map((worker) => worker.id)
    .sort()
    .join("|");

  useEffect(() => {
    const targets = workers.filter(
      (worker) => worker.online && worker.downloadLocation === "local",
    );

    if (targets.length === 0) {
      setFilesByWorker({});
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    void (async () => {
      const next: Record<string, WatchFile[]> = {};

      await Promise.all(
        targets.map(async (worker) => {
          const workerDownloads = downloads.filter(
            (download) => download.status === "completed" && download.workerId === worker.id,
          );
          if (workerDownloads.length === 0) return;

          const byDownload: Record<string, WorkerLocalFile[]> = {};
          for (let i = 0; i < workerDownloads.length; i += ID_BATCH_SIZE) {
            const ids = workerDownloads.slice(i, i + ID_BATCH_SIZE).map((download) => download.id);
            try {
              Object.assign(byDownload, await getWorkerLocalFiles(worker.id, ids));
            } catch {
              // Worker went offline or the tunnel dropped — show nothing for it.
              return;
            }
          }

          const files: WatchFile[] = [];
          const seen = new Set<string>();
          for (const download of workerDownloads) {
            for (const file of byDownload[download.id] ?? []) {
              const kind = getMediaKind(file.name);
              if (!kind) continue;
              const dedupeKey = `${file.name}:${file.size}`;
              if (seen.has(dedupeKey)) continue;
              seen.add(dedupeKey);
              files.push({
                ...file,
                kind,
                downloadId: download.id,
                downloadName: download.fileName ?? file.name,
              });
            }
          }

          if (files.length > 0) {
            files.sort((a, b) => a.name.localeCompare(b.name));
            next[worker.id] = files;
          }
        }),
      );

      if (!cancelled) {
        setFilesByWorker(next);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [completedKey, onlineLocalKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo<WatchGroup[]>(
    () =>
      workers
        .filter((worker) => worker.online && worker.downloadLocation === "local")
        .map((worker) => ({ worker, files: filesByWorker[worker.id] ?? [] }))
        .filter((group) => group.files.length > 0),
    [workers, filesByWorker],
  );

  return { groups, loading, networkStatus };
}
