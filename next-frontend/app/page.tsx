"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { useProgress } from "./hooks/useProgress"; //need go deep
import { useWorkerProgress } from "./hooks/useWorkerProgress"; //need go deep
import { useDownloads } from "./hooks/useDownloads"; //need go deep
import { useWorkers } from "./hooks/useWorkers"; //need go deep
import { createDownload, deleteDownload, updateDownload, claimDownload } from "./actions/downloads"; //need go deep
import type { FileDownload } from "./db/schema"; //need go deep
import type { IDBFileDownload } from "./lib/idb/schema"; //need go deep
import type { FileInfo } from "./components/downloads";
import { startDownload } from "./lib/startDownload";
import {
  downloadWorkerLocalFile,
  openWorkerLocalFileInBrowser,
  getWorkerLocalFiles,
  isMultiPartPossible,
  type WorkerLocalFile,
} from "./lib/workerConnection";
import type { WorkerFileTransfer, WorkerFileTransferPart } from "./lib/sync-worker/workerProtocol";
import WorkerClient from "./lib/sync-worker/workerClient"; //need go deep
import { OfflineBanner } from "./components/OfflineBanner"; //need go deep
import {
  DownloadList,
  DownloadDetails,
  LocalDownloadTray,
  AddDownloadModal,
  EditDownloadModal,
  PartCountDialog,
} from "./components/downloads"; //need go deep

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

export default function Home() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<FileDownload | null>(null);
  const [workerFilesByDownload, setWorkerFilesByDownload] = useState<Record<string, WorkerLocalFile[]>>({});
  const [workerFileTransfers, setWorkerFileTransfers] = useState<Record<string, WorkerFileTransfer>>({});
  const [pendingPartDownload, setPendingPartDownload] = useState<{ download: FileDownload; file: WorkerLocalFile } | null>(null);

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
  }, [selectedId]); // re-attach when panel mounts/unmounts

  const { downloads: idbDownloads, networkStatus, syncNow } = useDownloads();
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

  const isFnEnd = useRef(true);
  const isDBCallActive = useRef(false);
  // Mirrors downloadingFileId as a ref so async closures always see the latest value
  // without needing downloadingFileId in their dependency arrays.
  const downloadingFileIdRef = useRef<string | null>(null);

  const activeDownload = downloads.find((d) => d.id === downloadingFileId);
  const isWorkerDownload = isWorkerLocation(activeDownload?.location);

  // ── Progress tracking — both backed by SharedWorker ──────────────────────
  // Only one of these is active at a time based on download type.
  // The SharedWorker opens ONE SSE / poll across all tabs.
  const { progress: expressProgress, isDone: expressIsDone, error: expressError } =
    useProgress(isWorkerDownload ? null : downloadingFileId);

  const { progress: workerProgress, isDone: workerIsDone } = useWorkerProgress(
    isWorkerDownload ? (activeDownload?.workerId ?? null) : null,
    isWorkerDownload ? downloadingFileId : null
  );

  const progress = isWorkerDownload ? workerProgress : expressProgress;
  const isDone   = isWorkerDownload ? workerIsDone   : expressIsDone;
  const error    = isWorkerDownload ? null            : expressError;

  // ── Start / track active download ────────────────────────────────────────
  const startActiveDownload = async (data: FileDownload[]) => {
    if (!isFnEnd.current) return;
    isFnEnd.current = false;

    try {
      // Clear tracking if the current download is in a terminal state
      if (downloadingFileIdRef.current) {
        const tracked = data.find((f) => f.id === downloadingFileIdRef.current);
        const isActive = tracked && (tracked.status === "downloading" || tracked.status === "pending");
        if (isActive) return; // still active — nothing to do
        downloadingFileIdRef.current = null;
        setDownloadingFileId(null);
      }

      // Show progress bar for:
      //   1. Any row currently downloading (highest priority)
      //   2. Pending rows that have been dispatched (workerId set = worker accepted it)
      // Do NOT show for pending rows with no workerId (not dispatched yet)
      const downloading = data.find((f) => f.status === "downloading");
      const dispatchedPending = data.find(
        (f) => f.status === "pending" && f.workerId !== null
      );
      const targetFile = downloading ?? dispatchedPending ?? null;

      if (targetFile) {
        downloadingFileIdRef.current = targetFile.id;
        setDownloadingFileId(targetFile.id);
      } else {
        downloadingFileIdRef.current = null;
        setDownloadingFileId(null);
      }
    } finally {
      isFnEnd.current = true;
    }
  };

  // Re-evaluate when IDB data changes
  useEffect(() => {
    if (downloads.length > 0) void startActiveDownload(downloads);
  }, [idbDownloads]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ask each assigned worker for files it still has. The list receives no
  // download icon until the worker confirms a completed local artifact exists.
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
      if (cancelled) return;
      setWorkerFilesByDownload(Object.assign({}, ...responses));
    });

    return () => { cancelled = true; };
  }, [workerFileAvailabilityKey, onlineWorkerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => client.current.subscribeWorkerFileTransfers(setWorkerFileTransfers), []);

  // Handle server/cloud dispatch from SharedWorker — claim and start via Express
  useEffect(() => {
    const wc = client.current;
    let unsub: (() => void) | null = null;

    void wc.init().then(() => {
      unsub = wc.subscribeServerDispatch(async (download: any) => {
        if (download.downloadType !== "http") return;
        const claim = await claimDownload(download.id);
        if (!claim.success) return;
        const { status } = await startDownload(claim.data!);
        if (!status) {
          await updateDownload(download.id, { status: "pending" });
        }
        syncNow();
      });
    });

    return () => { unsub?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle progress error — only act on genuine server-reported errors,
  // not on stale-progressMap 404s (those now arrive as done:true, error:null)
  useEffect(() => {
    if (error && error !== "Download not found") {
      // A real error came from Express (e.g. download actually failed mid-stream)
      (async () => {
        if (!downloadingFileIdRef.current || isDBCallActive.current) return;
        isDBCallActive.current = true;
        await updateDownload(downloadingFileIdRef.current, {
          status: "failed",
          errorMessage: error,
        });
        isDBCallActive.current = false;
        syncNow();
        downloadingFileIdRef.current = null;
        setDownloadingFileId(null);
      })();
    } else if (error === "Download not found") {
      // progressMap 404 — the download may actually be completed in the DB.
      // Don't mark failed here; the sync will fetch the real status.
      // Just stop tracking locally so the progress bar goes away.
      downloadingFileIdRef.current = null;
      setDownloadingFileId(null);
      syncNow();
    }
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  // When download finishes, sync IDB to pick up final status from DB
  useEffect(() => {
    if (isDone) {
      downloadingFileIdRef.current = null;
      setDownloadingFileId(null);
      // Reset both IDB and worker in-memory cursor so the terminal status
      // (completed/failed) is picked up unconditionally on the next sync.
      void client.current.resetCursorAndSync("downloads");
    }
  }, [isDone]); // eslint-disable-line react-hooks/exhaustive-deps

  // For worker downloads: watch IDB row status directly.
  // If the DB status becomes terminal while the progress bar is showing,
  // clear it immediately without waiting for the next 30s sync.
  useEffect(() => {
    if (!downloadingFileId || !isWorkerDownload) return;
    const row = downloads.find((d) => d.id === downloadingFileId);
    if (!row) return;
    if (row.status === "completed" || row.status === "failed") {
      downloadingFileIdRef.current = null;
      setDownloadingFileId(null);
    }
  }, [downloads, downloadingFileId, isWorkerDownload]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ─────────────────────────────────────────────────────────────

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

  const handleAddDownload = async (url: string, location: string, fileName: string, fileInfo: FileInfo) => {
    setLoading(true);
    try {
      await createDownload(url, location, fileName, fileInfo.fileSize, fileInfo.fileType);
      setIsModalOpen(false);
      // Just create the DB record — the SharedWorker dispatcher will trigger it
      syncNow();
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const result = await deleteDownload(id);
      if (result.success) {
        if (id === downloadingFileIdRef.current) {
          client.current.stopTracking();
          downloadingFileIdRef.current = null;
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
      const result = await updateDownload(id, data);
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
    try {
      await downloadWorkerLocalFile(download.workerId, download.id, file, (received, total, parts) => {
        latestParts = parts;
        report(received, total, "downloading");
      }, parts);
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

  const selectedDownload = downloads.find((d) => d.id === selectedId);

  return (
    <main className="bg-background p-4 md:p-6">
      <div className="max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6"
        >
          <div>
            <h2 className="text-xl md:text-2xl font-bold">HTTP Downloads</h2>
            <p className="text-sm text-muted-foreground mt-1">Download files from direct URLs</p>
          </div>
          <Button
            onClick={() => setIsModalOpen(true)}
            className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 py-2 cursor-pointer"
          >
            + Add Download
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

        <LocalDownloadTray transfers={workerFileTransfers} workerNames={Object.fromEntries(workers.map((worker) => [worker.id, worker.name]))} />

        {/* Spacer: exact height of the panel so covered rows can be scrolled into view */}
        {selectedId && <div style={{ height: panelHeight }} className="shrink-0" aria-hidden="true" />}
      </div>

      <AddDownloadModal
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
