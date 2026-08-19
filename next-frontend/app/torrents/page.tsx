"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { useProgress } from "../hooks/useProgress";
import { useWorkerProgress } from "../hooks/useWorkerProgress";
import { useTorrents } from "../hooks/useTorrents";
import { useWorkers } from "../hooks/useWorkers";
import {
  createTorrentDownload,
  deleteTorrentDownload,
  updateTorrentDownload,
  claimTorrentDownload,
} from "../actions/torrents";import type { FileDownload } from "../db/schema";
import type { IDBFileDownload } from "../lib/idb/schema";
import useTorrentService from "../service/torrentService";
import WorkerClient from "../lib/sync-worker/workerClient";
import { startDownload } from "../lib/startDownload";
import {
  downloadWorkerLocalFile,
  getWorkerLocalFiles,
  openWorkerLocalFileInBrowser,
  isMultiPartPossible,
  restartWorkerPart,
  type WorkerLocalFile,
} from "../lib/workerConnection";
import type { WorkerFileTransfer, WorkerFileTransferPart } from "../lib/sync-worker/workerProtocol";
import { OfflineBanner } from "../components/OfflineBanner";
import {
  DownloadList,
  DownloadDetails,
  LocalDownloadTray,
  EditDownloadModal,
  PartCountDialog,
} from "../components/downloads";
import { AddTorrentModal } from "../components/torrents/AddTorrentModal";
import type { SelectedFilesMeta } from "../components/torrents/AddTorrentModal";

function isWorkerLocation(location: string | null | undefined): boolean {
  if (!location) return false;
  return location.startsWith("worker-") || location === "all-workers";
}

function toFileDownload(row: IDBFileDownload): FileDownload {
  return {
    ...row,
    createdAt: row.createdAt ? new Date(row.createdAt) : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt) : null,
  };
}

export default function TorrentsPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<FileDownload | null>(null);
  const [workerFilesByDownload, setWorkerFilesByDownload] = useState<Record<string, WorkerLocalFile[]>>({});
  const [workerFileTransfers, setWorkerFileTransfers] = useState<Record<string, WorkerFileTransfer>>({});
  const [pendingPartDownload, setPendingPartDownload] = useState<{ download: FileDownload; file: WorkerLocalFile } | null>(null);

  const { downloads: idbDownloads, networkStatus, syncNow } = useTorrents();
  const downloads = idbDownloads.map(toFileDownload);
  const workerFileAvailabilityKey = downloads
    .filter((download) => download.status === "completed" && !!download.workerId)
    .map((download) => `${download.id}:${download.workerId}:${download.updatedAt?.getTime() ?? 0}`)
    .sort()
    .join("|");
  const { workers } = useWorkers();
  const onlineWorkerKey = workers
    .filter((worker) => worker.online)
    .map((worker) => worker.id)
    .sort()
    .join("|");
  const client = useRef(WorkerClient.getInstance());

  // Refs for outside-click detection on the details panel
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);

  // Dynamically track panel height so the spacer always matches
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setPanelHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [selectedId]);

  const torrentService = useTorrentService();
  const isFnEnd = useRef(true);
  const isDBCallActive = useRef(false);

  const activeDownload = downloads.find((d) => d.id === downloadingFileId);
  const isWorkerDownload = isWorkerLocation(activeDownload?.location);

  // SharedWorker-backed progress — one connection across all tabs
  const { progress: expressProgress, isDone: expressIsDone, error: expressError } =
    useProgress(isWorkerDownload ? null : downloadingFileId);

  const { progress: workerProgress, isDone: workerIsDone } = useWorkerProgress(
    isWorkerDownload ? (activeDownload?.workerId ?? null) : null,
    isWorkerDownload ? downloadingFileId : null
  );

  const progress = isWorkerDownload ? workerProgress : expressProgress;
  const isDone   = isWorkerDownload ? workerIsDone   : expressIsDone;
  const error    = isWorkerDownload ? null            : expressError;

  const startActiveDownload = async (data: FileDownload[]) => {
    if (!isFnEnd.current) return;
    isFnEnd.current = false;

    try {
      if (downloadingFileId) {
        const tracked = data.find((f) => f.id === downloadingFileId);
        const isActive = tracked && (tracked.status === "downloading" || tracked.status === "pending");
        if (isActive) return;
        setDownloadingFileId(null);
      }

      const downloading = data.find((f) => f.status === "downloading");
      const dispatchedPending = data.find(
        (f) => f.status === "pending" && f.workerId !== null
      );
      const targetFile = downloading ?? dispatchedPending ?? null;

      if (targetFile) {
        setDownloadingFileId(targetFile.id);
      } else {
        setDownloadingFileId(null);
      }
    } finally {
      isFnEnd.current = true;
    }
  };

  useEffect(() => {
    if (downloads.length > 0) void startActiveDownload(downloads);
  }, [idbDownloads]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle server dispatch from SharedWorker for torrent downloads
  useEffect(() => {
    const wc = client.current;
    let unsub: (() => void) | null = null;

    void wc.init().then(() => {
      unsub = wc.subscribeServerDispatch(async (download: any) => {
        if (download.downloadType !== "torrent") return;
        const claim = await claimTorrentDownload(download.id);
        if (!claim.success) return;
        const { status } = await torrentService.startDownload(claim.data!);
        if (!status) {
          await updateTorrentDownload(download.id, { status: "pending" });
        }
        syncNow();
      });
    });

    return () => { unsub?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (error === "Download not found") {
      (async () => {
        if (!downloadingFileId || isDBCallActive.current) return;
        isDBCallActive.current = true;
        await updateTorrentDownload(downloadingFileId, {
          status: "failed",
          errorMessage: "Download not found in server cache",
        });
        isDBCallActive.current = false;
        syncNow();
        setDownloadingFileId(null);
      })();
    }
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isDone) {
      setDownloadingFileId(null);
      void import("../lib/idb/IDBStore").then(({ setCursor }) => {
        void setCursor("torrents_cursor", new Date(0).toISOString());
      });
      syncNow();
    }
  }, [isDone]); // eslint-disable-line react-hooks/exhaustive-deps

  // For worker downloads: watch IDB row status directly so the progress bar
  // clears immediately without waiting for the next 30s sync cycle.
  useEffect(() => {
    if (!downloadingFileId || !isWorkerDownload) return;
    const row = downloads.find((d) => d.id === downloadingFileId);
    if (!row) return;
    if (row.status === "completed" || row.status === "failed") {
      setDownloadingFileId(null);
    }
  }, [downloads, downloadingFileId, isWorkerDownload]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAddDownload = async (
    magnetLink: string,
    location: string,
    fileIndices: number[],
    meta: SelectedFilesMeta
  ) => {
    setLoading(true);
    try {
      const result = await createTorrentDownload(magnetLink, location, fileIndices, meta);
      if (!result.success) {
        alert(result.message ?? "Failed to create download");
        return;
      }
      // Just create the DB record — SharedWorker dispatcher will trigger it
      setIsModalOpen(false);
      syncNow();
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const result = await deleteTorrentDownload(id);
      if (result.success) {
        if (id === downloadingFileId) {
          client.current.stopTracking();
          setDownloadingFileId(null);
        }
        await client.current.deleteDownload(id);
        syncNow();
      } else {
        alert(result.message);
      }
    } finally {
      setDeletingId(null);
    }
  };

  const handleEditSubmit = async (
    id: string,
    data: { sourceUrl: string; fileName?: string; location: "server" | "cloud" | "mega" }
  ) => {
    setLoading(true);
    try {
      const result = await updateTorrentDownload(id, data);
      if (result.success) {
        setEditingFile(null);
        syncNow();
      } else {
        alert(result.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const selectedDownload = downloads.find((d) => d.id === selectedId);

  // Close the details panel when clicking outside both the list and the panel
  useEffect(() => {
    if (!selectedId) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const inList  = listRef.current?.contains(target);
      const inPanel = panelRef.current?.contains(target);
      if (!inList && !inPanel) setSelectedId(null);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [selectedId]);

  // Render a local-worker download icon only after the worker confirms the
  // completed artifact still exists.
  useEffect(() => {
    const groups = new Map<string, string[]>();
    for (const download of downloads) {
      if (download.status !== "completed" || !download.workerId || !workers.some((worker) => worker.id === download.workerId && worker.online)) continue;
      const ids = groups.get(download.workerId) ?? [];
      ids.push(download.id);
      groups.set(download.workerId, ids);
    }

    if (groups.size === 0) {
      setWorkerFilesByDownload({});
      return;
    }

    let cancelled = false;
    void Promise.all(
      [...groups.entries()].map(async ([workerId, downloadIds]) => {
        try { return await getWorkerLocalFiles(workerId, downloadIds); }
        catch { return {}; }
      }),
    ).then((responses) => {
      if (!cancelled) setWorkerFilesByDownload(Object.assign({}, ...responses));
    });

    return () => { cancelled = true; };
  }, [workerFileAvailabilityKey, onlineWorkerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => client.current.subscribeWorkerFileTransfers(setWorkerFileTransfers), []);

  const runWorkerFileDownload = async (download: FileDownload, file: WorkerLocalFile, parts: number) => {
    if (!download.workerId) return;

    const transferId = `${download.workerId}:${download.id}:${file.index}`;
    const startedAt = Date.now();
    let previousBytes = 0;
    let previousAt = startedAt;
    let lastReportedAt = 0;
    let latestParts: WorkerFileTransferPart[] | undefined;
    const report = (receivedBytes: number, totalBytes: number | null, status: WorkerFileTransfer["status"], error?: string) => {
      const now = Date.now();
      const speed = now > previousAt ? ((receivedBytes - previousBytes) * 1000) / (now - previousAt) : null;
      previousBytes = receivedBytes; previousAt = now;
      if (status === "downloading" && now - lastReportedAt < 250) return;
      lastReportedAt = now;
      client.current.reportWorkerFileTransfer({ id: transferId, workerId: download.workerId!, downloadId: download.id, fileIndex: file.index, fileName: file.name, status, receivedBytes, totalBytes, speedBytesPerSecond: speed, startedAt, updatedAt: now, error, parts: latestParts });
    };
    const control = downloadWorkerLocalFile(download.workerId, download.id, file, (received, total, parts) => {
      latestParts = parts;
      report(received, total, "downloading");
    }, parts);
    try {
      await control.promise;
      report(file.size, file.size, "completed");
    } catch (error: any) {
      if (error?.name === "AbortError") return;
      report(previousBytes, file.size, "failed", error?.message);
      alert(error?.message ?? "Could not download this file from the worker");
    }
  };

  const handleDownloadWorkerFile = async (download: FileDownload, files: WorkerLocalFile[]) => {
    if (!download.workerId || files.length === 0) return;

    let file = files[0];
    if (files.length > 1) {
      const options = files.map((item, index) => `${index + 1}. ${item.name}`).join("\n");
      const chosen = window.prompt(`Choose a torrent file to download:\n\n${options}`, "1");
      const index = Number(chosen) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= files.length) return;
      file = files[index];
    }

    // Ask for the part count when parallel splitting is possible
    if (isMultiPartPossible(file.size)) {
      setPendingPartDownload({ download, file });
      return;
    }
    await runWorkerFileDownload(download, file, 1);
  };

  const handleDownloadWorkerFileExternalLink = async (download: FileDownload, files: WorkerLocalFile[]) => {
    if (!download.workerId || files.length === 0) return;

    let file = files[0];
    if (files.length > 1) {
      const options = files.map((item, index) => `${index + 1}. ${item.name}`).join("\n");
      const chosen = window.prompt(`Choose a torrent file to download:\n\n${options}`, "1");
      const index = Number(chosen) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= files.length) return;
      file = files[index];
    }

    try {
      await openWorkerLocalFileInBrowser(download.workerId, download.id, file);
    } catch (error: any) {
      alert(error?.message ?? "Could not download this file from the worker");
    }
  };

  return (
    <main className="bg-background p-4 md:p-6">
      <div className="max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6"
        >
          <div>
            <h2 className="text-xl md:text-2xl font-bold">Torrent Downloads</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Download torrents via magnet links
            </p>
          </div>
          <Button
            onClick={() => setIsModalOpen(true)}
            className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 py-2 cursor-pointer"
          >
            + Add Torrent
          </Button>
        </motion.div>

        <OfflineBanner networkStatus={networkStatus} />

        <div ref={listRef}>
          <DownloadList
            downloads={downloads}
            downloadingFileId={downloadingFileId}
            deletingId={deletingId}
            selectedId={selectedId}
            progress={progress}
            onSelect={setSelectedId}
            onDelete={handleDelete}
            onEdit={setEditingFile}
            workerFilesByDownload={workerFilesByDownload}
            onDownloadWorkerFile={handleDownloadWorkerFile}
            onDownloadWorkerFileExternalLink={handleDownloadWorkerFileExternalLink}
            workerFileTransfers={workerFileTransfers}
          />
        </div>

        <DownloadDetails
          download={selectedDownload ?? null}
          isDownloading={downloadingFileId === selectedId}
          progress={downloadingFileId === selectedId ? progress : null}
          onClose={() => setSelectedId(null)}
          panelRef={panelRef}
        />

        <LocalDownloadTray
          transfers={workerFileTransfers}
          workerNames={Object.fromEntries(workers.map((worker) => [worker.id, worker.name]))}
          onRestartPart={restartWorkerPart}
        />

        {/* Spacer: exact height of the panel so covered rows can be scrolled into view */}
        {selectedId && <div style={{ height: panelHeight }} className="shrink-0" aria-hidden="true" />}
      </div>

      <AddTorrentModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSubmit={handleAddDownload}
        loading={loading}
        workers={workers}
      />

      <EditDownloadModal
        file={editingFile}
        onClose={() => setEditingFile(null)}
        onSubmit={handleEditSubmit}
        loading={loading}
      />

      <PartCountDialog
        isOpen={pendingPartDownload !== null}
        fileSize={pendingPartDownload?.file.size ?? 0}
        onClose={() => setPendingPartDownload(null)}
        onConfirm={(parts) => {
          if (pendingPartDownload) {
            void runWorkerFileDownload(pendingPartDownload.download, pendingPartDownload.file, parts);
          }
          setPendingPartDownload(null);
        }}
      />
    </main>
  );
}
