"use client";

/**
 * useWorkerStatus
 *
 * Returns the online/offline status and last heartbeat for a single worker,
 * backed by the SharedWorker's SSE stream to /api/worker/[workerId]/status/stream.
 *
 * Live metrics, task progress, and logs are now streamed directly from the
 * worker's own /stream endpoint (see WorkerDetails.tsx → openWorkerStream).
 */

import { useState, useEffect, useRef } from "react";
import WorkerClient from "@/app/lib/sync-worker/workerClient";
import type { WorkerStatusPayload } from "@/app/lib/sync-worker/workerClient";

export interface WorkerStatus {
  online:        boolean;
  lastHeartbeat: string | null;
  pinggyUrl:     string | null;
  version:       string;
}

export function useWorkerStatus(workerId: string | null) {
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const client = useRef(WorkerClient.getInstance());

  useEffect(() => {
    if (!workerId) {
      setStatus(null);
      return;
    }

    const wc = client.current;
    void wc.init();

    const onStatus = (payload: WorkerStatusPayload) => {
      setStatus({
        online:        payload.online,
        lastHeartbeat: payload.lastHeartbeat ?? null,
        pinggyUrl:     payload.pinggyUrl     ?? null,
        version:       payload.version       ?? "1.0.0",
      });
    };

    const unsub = wc.subscribeWorkerStatus(workerId, onStatus);
    return () => unsub();
  }, [workerId]);

  return { status };
}
