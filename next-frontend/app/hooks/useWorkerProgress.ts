import { useState, useEffect, useRef, useCallback } from "react";

export interface WorkerProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  percentFixed2: string | null;
  done?: boolean;
  error?: string;
}

/**
 * Polls the worker store status endpoint to get real-time download progress
 * for a download that is being processed by a worker.
 *
 * workerId  — the worker handling the download (from fileDownload.workerId)
 * downloadId — the download being tracked
 */
export function useWorkerProgress(
  workerId: string | null | undefined,
  downloadId: string | null | undefined,
  pollInterval = 3000
) {
  const [progress, setProgress] = useState<WorkerProgress | null>(null);
  const [isDone, setIsDone] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    if (!workerId || !downloadId) return;

    try {
      const res = await fetch(`/api/worker/${workerId}/status`);
      if (!res.ok) return;

      const data = await res.json();
      const task = data?.currentTask;

      if (task && task.downloadId === downloadId) {
        const pct = task.progress ?? 0;
        setProgress({
          downloadedBytes: 0,       // worker doesn't expose bytes here
          totalBytes: null,
          percent: pct,
          percentFixed2: pct.toFixed(2),
          done: task.status === "completed",
          error: task.status === "failed" ? "Download failed" : undefined,
        });

        if (task.status === "completed" || task.status === "failed") {
          setIsDone(true);
          stop();
        }
      } else if (data?.online === false) {
        // Worker went offline
        setProgress((prev) =>
          prev ? { ...prev, error: "Worker went offline", done: true } : null
        );
        setIsDone(true);
        stop();
      }
      // If task is null but worker is online, the download may have just
      // completed — the DB poll in page.tsx will catch the status change.
    } catch {
      // network error — keep polling
    }
  }, [workerId, downloadId, stop]);

  useEffect(() => {
    if (!workerId || !downloadId) {
      stop();
      setProgress(null);
      setIsDone(false);
      return;
    }

    setIsDone(false);
    poll(); // immediate first call
    timerRef.current = setInterval(poll, pollInterval);

    return stop;
  }, [workerId, downloadId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { progress, isDone };
}
