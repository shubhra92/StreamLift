"use client";

/**
 * useWorkerStatus
 *
 * Backed by the SharedWorker — the worker opens ONE SSE stream per watched
 * workerId across all tabs. All tabs receive the same status broadcasts.
 *
 * Replaces the old per-tab EventSource approach.
 */

import { useState, useEffect, useRef } from "react";
import WorkerClient from "@/app/lib/sync-worker/workerClient";
import type { WorkerStatusPayload } from "@/app/lib/sync-worker/workerClient";
import type { WorkerMetrics, WorkerLog, WorkerTask } from "@/app/lib/workerStore";

export interface WorkerStatus {
  online: boolean;
  ipAddress: string | null;
  lastHeartbeat: string | null;
  metrics: WorkerMetrics | null;
  currentTask: WorkerTask | null;
  logs: WorkerLog[];
  version: string;
}

export function useWorkerStatus(workerId: string | null) {
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = useRef(WorkerClient.getInstance());

  // Frontend log buffer — accumulates all logs for this session
  const logsBufferRef = useRef<WorkerLog[]>([]);
  const seenLogKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!workerId) {
      setStatus(null);
      setError(null);
      logsBufferRef.current = [];
      seenLogKeysRef.current = new Set();
      return;
    }

    // Reset log buffer when switching workers
    logsBufferRef.current = [];
    seenLogKeysRef.current = new Set();

    const wc = client.current;
    void wc.init();

    const onStatus = (payload: WorkerStatusPayload) => {
      // Merge incoming logs into the session buffer (deduped)
      const incoming = (payload.logs ?? []) as WorkerLog[];
      for (const log of incoming) {
        const key = `${log.timestamp}:${log.message}`;
        if (!seenLogKeysRef.current.has(key)) {
          seenLogKeysRef.current.add(key);
          logsBufferRef.current = [...logsBufferRef.current, log];
        }
      }

      setStatus({
        online:        payload.online,
        ipAddress:     payload.ipAddress,
        lastHeartbeat: payload.lastHeartbeat,
        metrics:       payload.metrics as WorkerMetrics | null,
        currentTask:   payload.currentTask as WorkerTask | null,
        logs:          logsBufferRef.current,
        version:       payload.version,
      });
      setError(null);
    };

    const unsub = wc.subscribeWorkerStatus(workerId, onStatus);

    return () => {
      unsub();
    };
  }, [workerId]);

  return { status, error };
}
