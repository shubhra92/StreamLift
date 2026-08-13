"use client";

/**
 * useProgress
 *
 * Backed by the SharedWorker — the worker opens ONE SSE connection
 * across all tabs. Progress events are broadcast to all tabs.
 *
 * When id is set: tell the worker to start tracking this download.
 * When id is null: tell the worker to stop tracking.
 */

import { useState, useEffect, useRef } from "react";
import WorkerClient from "@/app/lib/sync-worker/workerClient";
import type { ProgressPayload } from "@/app/lib/sync-worker/workerProtocol";

export type { ProgressPayload as Progress };

export function useProgress(id: string | null) {
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = useRef(WorkerClient.getInstance());

  useEffect(() => {
    const wc = client.current;
    let cancelled = false;

    const onProgress = (payload: ProgressPayload) => {
      setProgress(payload);
      if (payload.error) setError(payload.error);
      else setError(null);
    };

    const unsub = wc.subscribeProgress(onProgress);

    wc.init().then(() => {
      if (cancelled) return;
      if (id) {
        wc.trackDownload(id, null, "express");
      } else {
        wc.stopTracking();
        setProgress(null);
        setError(null);
      }
    });

    return () => {
      cancelled = true;
      unsub();
      if (id) wc.stopTracking();
    };
  }, [id]);

  return {
    progress,
    error,
    isDone: progress?.done ?? false,
  };
}
