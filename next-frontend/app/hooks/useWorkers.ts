"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import WorkerClient from "@/app/lib/sync-worker/workerClient";
import type { IDBWorker } from "@/app/lib/idb/schema";

export type NetworkStatus = "online" | "offline";

// IDBWorker now includes online/ipAddress/lastHeartbeat — this alias
// is kept for backwards compatibility with workers/page.tsx
export interface WorkerWithRuntime extends IDBWorker {}

export interface UseWorkersOptions {
  /** When false the hook does nothing. Defaults to true. */
  enabled?: boolean;
}

export interface UseWorkersResult {
  workers: IDBWorker[];
  networkStatus: NetworkStatus;
  syncNow: () => void;
}

export function useWorkers(options: UseWorkersOptions = {}): UseWorkersResult {
  const { enabled = true } = options;
  const [workers, setWorkers] = useState<IDBWorker[]>([]);
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>("online");
  const client = useRef(WorkerClient.getInstance());

  useEffect(() => {
    if (!enabled) {
      setWorkers([]);
      return;
    }

    const wc = client.current;
    void wc.init();

    const onData = (rows: IDBWorker[]) => setWorkers(rows);
    const unsubNetwork = wc.subscribeNetwork((s) => setNetworkStatus(s));

    wc.subscribe("workers", onData);

    // visibilitychange sync — only useful on the workers page where
    // enabled is always true (not on downloads/torrents where it's modal-gated)
    const onVisibilityChange = enabled === true
      ? () => { if (document.visibilityState === "visible") wc.syncNow("workers"); }
      : null;

    if (onVisibilityChange) {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      wc.unsubscribe("workers", onData);
      unsubNetwork();
      if (onVisibilityChange) {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [enabled]);

  const syncNow = useCallback(() => {
    client.current.syncNow("workers");
  }, []);

  return { workers, networkStatus, syncNow };
}
