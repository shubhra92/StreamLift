"use client";

/**
 * useWorkerProgress
 *
 * For worker downloads (v2), progress comes directly from the worker's
 * /stream SSE endpoint via openWorkerStream. The currentTask.progress
 * field is mapped to the ProgressPayload shape the downloads page expects.
 *
 * When done is detected, triggers an immediate IDB sync so the download
 * list updates without waiting for the next 30s cycle.
 */

import { useState, useEffect, useRef } from "react";
import { openWorkerStream } from "@/app/lib/workerConnection";

export interface WorkerProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  percentFixed2: string | null;
  done?: boolean;
  error?: string;
}

function triggerImmediateSync() {
  void import("@/app/lib/sync-worker/workerClient").then(({ default: WorkerClient }) => {
    const wc = WorkerClient.getInstance();
    wc.syncNow("downloads");
    wc.syncNow("torrents");
  });
}

export function useWorkerProgress(
  workerId: string | null | undefined,
  downloadId: string | null | undefined,
) {
  const [progress, setProgress] = useState<WorkerProgress | null>(null);
  const [isDone, setIsDone] = useState(false);
  const streamRef = useRef<{ close: () => void } | null>(null);

  useEffect(() => {
    if (!workerId || !downloadId) {
      setProgress(null);
      setIsDone(false);
      return;
    }

    let cancelled = false;

    openWorkerStream(
      workerId,
      (data: any) => {
        if (cancelled) return;

        const task = data?.currentTask;

        // The terminal/visual state of a download comes from the synced DB row,
        // not from the worker stream. The SSE only drives the live progress bar:
        // - task present for our download → map currentTask.progress + status.
        // - task completed/failed → trigger an immediate DB sync.
        // - task missing mid-stream (worker restart while our job was active) →
        //   keep the last known progress untouched; the DB row stays the source
        //   of truth for whether it completed or failed.
        if (task && task.downloadId === downloadId) {
          const pct = typeof task.progress === "number" ? task.progress : null;
          const isDoneStatus = task.status === "completed" || task.status === "failed";

          setProgress({
            downloadedBytes: 0,
            totalBytes:      null,
            percent:         pct,
            percentFixed2:   pct != null ? pct.toFixed(2) : null,
            done:            isDoneStatus,
            error:           task.status === "failed" ? "Download failed" : undefined,
          });

          if (isDoneStatus) {
            setIsDone(true);
            triggerImmediateSync();
          }
        }
      },
      (_errMsg: string) => {
        // No-op on transient stream errors — the tunnel URL and session token
        // do not change, so the cached connection stays valid for downloads.
        // (Invalidating it here used to make every part hit the backend.)
      },
    ).then((handle) => {
      if (cancelled) { handle.close(); return; }
      streamRef.current = handle;
    }).catch(() => {
      // Connection failed — progress won't update but page will still sync on schedule
    });

    return () => {
      cancelled = true;
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [workerId, downloadId]);

  return { progress, isDone };
}
