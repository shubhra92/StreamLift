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
import WorkerClient from "./lib/sync-worker/workerClient"; //need go deep
import { OfflineBanner } from "./components/OfflineBanner"; //need go deep
import {
  DownloadList,
  DownloadDetails,
  AddDownloadModal,
  EditDownloadModal,
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

  // Refs for outside-click detection on the details panel
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const { downloads: idbDownloads, networkStatus, syncNow } = useDownloads();
  const downloads = idbDownloads.map(toFileDownload);
  const { workers } = useWorkers({ enabled: isModalOpen });
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
      // If we're already tracking a download, check whether it has reached
      // a terminal state in the latest IDB data. If it has, clear tracking
      // and let the logic below re-evaluate for a new active download.
      if (downloadingFileIdRef.current) {
        const tracked = data.find((f) => f.id === downloadingFileIdRef.current);
        const isTerminal = !tracked || (tracked.status !== "downloading" && tracked.status !== "pending");
        if (!isTerminal) return; // still active — nothing to do
        // Terminal: clear tracking state so we fall through to re-evaluation
        downloadingFileIdRef.current = null;
        setDownloadingFileId(null);
      }

      let targetFile: FileDownload | null = null;
      const targetStatus = new Set(["downloading", "pending"]);

      for (const f of data) {
        if (!targetStatus.has(f.status!)) continue;
        if (f.status === "downloading") { targetFile = f; break; }
        if (!targetFile) { targetFile = f; continue; }
        if (new Date(f.updatedAt!) < new Date(targetFile.updatedAt!)) targetFile = f;
      }

      if (targetFile?.status === "pending") {
        if (isWorkerLocation(targetFile.location)) {
          downloadingFileIdRef.current = targetFile.id;
          setDownloadingFileId(targetFile.id);
        } else {
          const claim = await claimDownload(targetFile.id);
          if (!claim.success) {
            downloadingFileIdRef.current = targetFile.id;
            setDownloadingFileId(targetFile.id);
            return;
          }
          const { status, message } = await startDownload(targetFile);
          if (!status) {
            console.log(message);
            await updateDownload(targetFile.id, { status: "pending" });
          } else {
            downloadingFileIdRef.current = targetFile.id;
            setDownloadingFileId(targetFile.id);
            syncNow();
          }
        }
      } else if (targetFile) {
        // Row is already 'downloading' — reconnecting after a reload.
        downloadingFileIdRef.current = targetFile.id;
        setDownloadingFileId(targetFile.id);
        await client.current.resetCursorAndSync("downloads");
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
    data: { sourceUrl: string; fileName?: string; location: "server" | "mega" }
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

  const selectedDownload = downloads.find((d) => d.id === selectedId);

  return (
    <main className="min-h-screen bg-background p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
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
            progress={progress}
            onSelect={setSelectedId}
            onDelete={handleDelete}
            onEdit={setEditingFile}
          />
        </div>

        <DownloadDetails
          download={selectedDownload ?? null}
          isDownloading={downloadingFileId === selectedId}
          progress={downloadingFileId === selectedId ? progress : null}
          onClose={() => setSelectedId(null)}
          panelRef={panelRef}
        />
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
    </main>
  );
}
