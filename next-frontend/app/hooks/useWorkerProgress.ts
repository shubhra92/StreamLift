"use client";

/**
 * useWorkerProgress
 *
 * Backed by the SharedWorker — the worker polls the worker status endpoint
 * in one place across all tabs.
 */

import { useState, useEffect, useRef } from "react";
import WorkerClient from "@/app/lib/sync-worker/workerClient";
import type { ProgressPayload } from "@/app/lib/sync-worker/workerProtocol";

export interface WorkerProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  percentFixed2: string | null;
  done?: boolean;
  error?: string;
}

export function useWorkerProgress(
  workerId: string | null | undefined,
  downloadId: string | null | undefined,
) {
  const [progress, setProgress] = useState<WorkerProgress | null>(null);
  const [isDone, setIsDone] = useState(false);
  const client = useRef(WorkerClient.getInstance());

  useEffect(() => {
    if (!workerId || !downloadId) {
      setProgress(null);
      setIsDone(false);
      return;
    }

    const wc = client.current;
    let cancelled = false;

    const onProgress = (payload: ProgressPayload) => {
      setProgress(payload);
      if (payload.done) setIsDone(true);
    };

    const unsub = wc.subscribeProgress(onProgress);

    // Await init so trackDownload is sent after the port is established.
    wc.init().then(() => {
      if (cancelled) return;
      wc.trackDownload(downloadId, workerId, "worker");
    });

    return () => {
      cancelled = true;
      unsub();
      wc.stopTracking();
    };
  }, [workerId, downloadId]);

  return { progress, isDone };
}
