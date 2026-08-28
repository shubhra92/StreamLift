"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
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
  buildParts,
  downloadCloudFileToDisk,
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
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [editingFile, setEditingFile] = useState<FileDownload | null>(null);
  const [workerFilesByDownload, setWorkerFilesByDownload] = useState<Record<string, WorkerLocalFile[]>>({});
  const [workerFileTransfers, setWorkerFileTransfers] = useState<Record<string, WorkerFileTransfer>>({});
  const [pendingPartDownload, setPendingPartDownload] = useState<{ download: FileDownload; file: WorkerLocalFile } | null>(null);
  const [pendingCloudDownload, setPendingCloudDownload] = useState<{ download: FileDownload; shareUrl: string; fileName: string; fileSize: number } | null>(null);
  const [creatingLinkIds, setCreatingLinkIds] = useState<Set<string>>(new Set());

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
  const contentRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const cloudControlsRef = useRef<Map<string, { retryPart: (partIndex: number) => void }>>(new Map());

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
    setDeletingIds((prev) => new Set(prev).add(id));
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
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
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
      const inList  = contentRef.current?.contains(target);
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
      lastReportedAt = 0;
      report(file.size, file.size, "downloading");
      await new Promise((r) => setTimeout(r, 600));
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

  const handleCreateShareLink = async (download: FileDownload) => {
    setCreatingLinkIds((prev) => new Set(prev).add(download.id));
    try {
      const res = await fetch(`/api/cloud/share/${download.id}`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? "Failed to create share link");
        return;
      }
      syncNow();
    } catch (err: any) {
      alert(err?.message ?? "Failed to create share link");
    } finally {
      setCreatingLinkIds((prev) => {
        const next = new Set(prev);
        next.delete(download.id);
        return next;
      });
    }
  };

  const handleCloudExternalLink = async (download: FileDownload) => {
    try {
      const res = await fetch(`/api/cloud/download-info/${download.id}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? "Could not get download info");
        return;
      }
      const { shareUrl } = await res.json();
      if (shareUrl) window.open(shareUrl, "_blank");
    } catch (err: any) {
      alert(err?.message ?? "Download failed");
    }
  };

  const runCloudDownload = async (download: FileDownload, shareUrl: string, fileName: string, fileSize: number, parts: number) => {
    const transferId = `cloud:${download.id}`;
    const startedAt = Date.now();
    let previousBytes = 0;
    let previousAt = startedAt;
    let lastReportedAt = 0;
    let latestParts: WorkerFileTransferPart[] | undefined;

    const report = (receivedBytes: number, totalBytes: number, status: WorkerFileTransfer["status"], error?: string, cancelled?: boolean) => {
      const now = Date.now();
      const speed = now > previousAt ? ((receivedBytes - previousBytes) * 1000) / (now - previousAt) : null;
      previousBytes = receivedBytes;
      previousAt = now;
      if (status === "downloading" && now - lastReportedAt < 250) return;
      lastReportedAt = now;
      client.current.reportWorkerFileTransfer({
        id: transferId,
        workerId: "cloud",
        downloadId: download.id,
        fileIndex: 0,
        fileName,
        status,
        receivedBytes,
        totalBytes,
        speedBytesPerSecond: speed,
        startedAt,
        updatedAt: now,
        error,
        cancelled,
        parts: latestParts,
      });
    };

    // Seed the per-part list immediately so the tray shows the chosen parts (not a
    // single bar) the moment the save picker is confirmed, before data starts flowing.
    latestParts = buildParts(fileSize, parts);

    report(0, fileSize, "preparing");

    const control = downloadCloudFileToDisk(
      shareUrl,
      fileName,
      fileSize,
      parts,
      (received, total, cloudParts) => {
        latestParts = cloudParts.map((p) => ({
          index: p.index,
          start: p.start,
          end: p.end,
          receivedBytes: p.receivedBytes,
          status: p.status === "pending" ? "pending" as const : p.status === "downloading" ? "downloading" as const : p.status === "completed" ? "completed" as const : "failed" as const,
          error: p.error,
          speedBytesPerSecond: p.speedBytesPerSecond,
          restartCount: p.restartCount,
          manualRestartCount: p.manualRestartCount,
          reconnecting: p.reconnecting,
        }));
        report(received, total, "downloading");
      },
      (checking) => {
        report(0, fileSize, checking ? "preparing" : "downloading");
      },
    );

    cloudControlsRef.current.set(transferId, control);

    try {
      await control.promise;
      lastReportedAt = 0;
      report(fileSize, fileSize, "downloading");
      await new Promise((r) => setTimeout(r, 600));
      report(fileSize, fileSize, "completed");
    } catch (error: any) {
      lastReportedAt = 0;
      if (error?.name === "AbortError") {
        report(0, fileSize, "preparing", undefined, true);
      } else {
        report(previousBytes, fileSize, "failed", error?.message ?? "Download failed");
      }
    } finally {
      cloudControlsRef.current.delete(transferId);
    }
  };

  const retryCloudPart = (transferId: string, partIndex: number) => {
    cloudControlsRef.current.get(transferId)?.retryPart(partIndex);
  };

  const handleCloudTabDownload = async (download: FileDownload) => {
    try {
      const res = await fetch(`/api/cloud/download-info/${download.id}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? "Could not get download info");
        return;
      }
      const { shareUrl, fileName } = await res.json();
      if (!shareUrl) {
        alert("No share link — click the link icon first");
        return;
      }
      const name = fileName ?? download.fileName ?? "download";
      const fileSize = download.fileSize ?? 0;

      if (isMultiPartPossible(fileSize)) {
        setPendingCloudDownload({ download, shareUrl, fileName: name, fileSize });
        return;
      }
      await runCloudDownload(download, shareUrl, name, fileSize, 1);
    } catch (err: any) {
      alert(err?.message ?? "Download failed");
    }
  };

  return (
    <main className="flex h-full flex-col bg-background">
      {/* Row 2 (mid, scrollable): page header + banner + download list — scroll together */}
      <div className="flex-1 min-h-0 overflow-y-auto w-full">
        <div ref={contentRef} className="max-w-5xl mx-auto px-4 md:px-6 pt-4 md:pt-6">
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4"
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

          <div className="h-4 md:h-6" />

          <DownloadList
            downloads={downloads}
            downloadingFileId={downloadingFileId}
            deletingIds={deletingIds}
            selectedId={selectedId}
            progress={progress}
            onSelect={setSelectedId}
            onDelete={handleDelete}
            onEdit={setEditingFile}
            workerFilesByDownload={workerFilesByDownload}
            onDownloadWorkerFile={handleDownloadWorkerFile}
            onDownloadWorkerFileExternalLink={handleDownloadWorkerFileExternalLink}
            workerFileTransfers={workerFileTransfers}
            onCreateShareLink={handleCreateShareLink}
            onCloudExternalLink={handleCloudExternalLink}
            onCloudTabDownload={handleCloudTabDownload}
            creatingLinkIds={creatingLinkIds}
          />
          <div className="h-4 md:h-6" />
        </div>
      </div>

      {/* Row 3 (bottom, dynamic): item detail — only when a row is selected */}
      <div className="shrink-0">
        <AnimatePresence>
          {selectedDownload && (
            <motion.div
              key="details-row"
              ref={panelRef}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: "spring", damping: 32, stiffness: 320 }}
              className="overflow-hidden"
            >
              <DownloadDetails
                download={selectedDownload}
                isDownloading={downloadingFileId === selectedId}
                progress={downloadingFileId === selectedId ? progress : null}
                onClose={() => setSelectedId(null)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <LocalDownloadTray
        transfers={workerFileTransfers}
        workerNames={Object.fromEntries(workers.map((worker) => [worker.id, worker.name]))}
        onRestartPart={restartWorkerPart}
        onRetryCloudPart={retryCloudPart}
      />

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

      <PartCountDialog
        isOpen={pendingCloudDownload !== null}
        fileSize={pendingCloudDownload?.fileSize ?? 0}
        onClose={() => setPendingCloudDownload(null)}
        onConfirm={(parts) => {
          if (pendingCloudDownload) {
            void runCloudDownload(pendingCloudDownload.download, pendingCloudDownload.shareUrl, pendingCloudDownload.fileName, pendingCloudDownload.fileSize, parts);
          }
          setPendingCloudDownload(null);
        }}
      />
    </main>
  );
}
