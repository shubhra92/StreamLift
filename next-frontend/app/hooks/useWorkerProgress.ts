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
import { openWorkerStream, invalidateWorkerConnection } from "@/app/lib/workerConnection";

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
    let lastTaskSeen = false; // true once we've seen this task in the SSE stream

    openWorkerStream(
      workerId,
      (data: any) => {
        if (cancelled) return;

        const task = data?.currentTask;

        if (task && task.downloadId === downloadId) {
          // Task is active for our download
          lastTaskSeen = true;
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
        } else if (lastTaskSeen) {
          // Task was active but is now null/different — it completed and was cleared
          setProgress((prev) =>
            prev ? { ...prev, done: true, percent: 100, percentFixed2: "100.00" } : null
          );
          setIsDone(true);
          lastTaskSeen = false;
          triggerImmediateSync();
        }
      },
      (_errMsg: string) => {
        if (!cancelled) {
          invalidateWorkerConnection(workerId);
        }
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
