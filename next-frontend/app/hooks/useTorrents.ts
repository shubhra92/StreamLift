"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import WorkerClient from "@/app/lib/sync-worker/workerClient";
import type { IDBFileDownload } from "@/app/lib/idb/schema";

export type NetworkStatus = "online" | "offline";

export interface UseTorrentsResult {
  downloads: IDBFileDownload[];
  networkStatus: NetworkStatus;
  syncNow: () => void;
}

export function useTorrents(): UseTorrentsResult {
  const [downloads, setDownloads] = useState<IDBFileDownload[]>([]);
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>("online");
  const client = useRef(WorkerClient.getInstance());

  useEffect(() => {
    const wc = client.current;
    void wc.init();

    const onData = (rows: IDBFileDownload[]) => setDownloads(rows);
    const unsubNetwork = wc.subscribeNetwork((s) => setNetworkStatus(s));

    wc.subscribe("torrents", onData);

    return () => {
      wc.unsubscribe("torrents", onData);
      unsubNetwork();
    };
  }, []);

  const syncNow = useCallback(() => {
    client.current.syncNow("torrents");
  }, []);

  return { downloads, networkStatus, syncNow };
}
