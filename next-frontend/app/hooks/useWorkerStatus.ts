import { useState, useEffect, useCallback, useRef } from "react";
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

export function useWorkerStatus(workerId: string | null, pollInterval = 10000) {
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "sse" | "polling">("idle");

  const eventSourceRef = useRef<EventSource | null>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  // Frontend log buffer — accumulates all logs for the session, never trimmed
  const logsBufferRef = useRef<WorkerLog[]>([]);
  // Track which log timestamps we've already seen to avoid duplicates
  const seenLogKeysRef = useRef<Set<string>>(new Set());

  const cleanup = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const mergeNewLogs = useCallback((incoming: WorkerLog[]) => {
    if (!incoming?.length) return;
    for (const log of incoming) {
      const key = `${log.timestamp}:${log.message}`;
      if (!seenLogKeysRef.current.has(key)) {
        seenLogKeysRef.current.add(key);
        logsBufferRef.current = [...logsBufferRef.current, log];
      }
    }
  }, []);

  const applyUpdate = useCallback(
    (data: Omit<WorkerStatus, "logs"> & { logs: WorkerLog[] }) => {
      mergeNewLogs(data.logs ?? []);
      setStatus({ ...data, logs: logsBufferRef.current });
      setError(null);
    },
    [mergeNewLogs]
  );

  const fetchStatus = useCallback(async () => {
    if (!workerId) return;
    try {
      const res = await fetch(`/api/worker/${workerId}/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      applyUpdate(data);
    } catch (err: any) {
      setError(err.message);
    }
  }, [workerId, applyUpdate]);

  const startPolling = useCallback(() => {
    if (!workerId || pollingRef.current) return;
    setMode("polling");
    fetchStatus();
    pollingRef.current = setInterval(fetchStatus, pollInterval);
  }, [workerId, pollInterval, fetchStatus]);

  const startSSE = useCallback(() => {
    if (!workerId) return;
    cleanup();
    setMode("sse");

    const es = new EventSource(`/api/worker/${workerId}/status/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.error) {
          setError(data.error);
          cleanup();
          setMode("idle");
          return;
        }
        applyUpdate(data);
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      cleanup();
      startPolling();
    };
  }, [workerId, cleanup, startPolling, applyUpdate]);

  useEffect(() => {
    if (workerId) {
      // Reset log buffer when switching workers
      logsBufferRef.current = [];
      seenLogKeysRef.current = new Set();
      startSSE();
    } else {
      cleanup();
      setMode("idle");
      setStatus(null);
      setError(null);
      logsBufferRef.current = [];
      seenLogKeysRef.current = new Set();
    }
    return cleanup;
  }, [workerId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { status, error, mode };
}
