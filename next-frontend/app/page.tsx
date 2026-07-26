"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { useProgress } from "./hooks/useProgress";
import { useWorkerProgress } from "./hooks/useWorkerProgress";
import { useDownloads } from "./hooks/useDownloads";
import { useWorkers } from "./hooks/useWorkers";
import { createDownload, deleteDownload, updateDownload, claimDownload } from "./actions/downloads";
import type { FileDownload } from "./db/schema";
import type { IDBFileDownload } from "./lib/idb/schema";
import useHomeService from "./service/homeService";
import WorkerClient from "./lib/sync-worker/workerClient";
import { OfflineBanner } from "./components/OfflineBanner";
import {
  DownloadList,
  DownloadDetails,
  AddDownloadModal,
  EditDownloadModal,
} from "./components/downloads";

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
  const [editingFile, setEditingFile] = useState<FileDownload | null>(null);

  const { downloads: idbDownloads, networkStatus, syncNow } = useDownloads();
  const downloads = idbDownloads.map(toFileDownload);
  const { workers } = useWorkers({ enabled: isModalOpen });
  const client = useRef(WorkerClient.getInstance());

  const homeService = useHomeService();
  const isFnEnd = useRef(true);
  const isDBCallActive = useRef(false);

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
    // Already tracking — don't re-evaluate to avoid multiple API calls
    if (downloadingFileId) {
      isFnEnd.current = true;
      return;
    }
    isFnEnd.current = false;

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
        // Worker downloads: don't claim — the worker picks up 'pending' rows
        // via heartbeat. Just track the download locally.
        setDownloadingFileId(targetFile.id);
      } else {
        // Non-worker (Express) downloads: atomically claim before calling Express
        // so only one tab starts the download.
        const claim = await claimDownload(targetFile.id);
        if (!claim.success) {
          // Another tab already claimed it — just track it
          setDownloadingFileId(targetFile.id);
          isFnEnd.current = true;
          return;
        }
        const { status, message } = await homeService.startDownload(targetFile);
        if (!status) {
          console.log(message);
          // Revert claim back to pending so it can be retried
          await updateDownload(targetFile.id, { status: "pending" });
        } else {
          setDownloadingFileId(targetFile.id);
          syncNow();
        }
      }
    } else if (targetFile) {
      setDownloadingFileId(targetFile.id);
    } else {
      setDownloadingFileId(null);
    }

    isFnEnd.current = true;
  };

  // Re-evaluate when IDB data changes
  useEffect(() => {
    if (downloads.length > 0) void startActiveDownload(downloads);
  }, [idbDownloads]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle progress error (Express down / download not found)
  useEffect(() => {
    if (error === "Download not found") {
      (async () => {
        if (!downloadingFileId || isDBCallActive.current) return;
        isDBCallActive.current = true;
        await updateDownload(downloadingFileId, {
          status: "failed",
          errorMessage: "Download not found in server cache",
        });
        isDBCallActive.current = false;
        syncNow();
        setDownloadingFileId(null);
      })();
    }
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  // When download finishes, sync IDB to pick up final status from DB
  useEffect(() => {
    if (isDone) {
      setDownloadingFileId(null);
      // Reset cursor so delta query picks up the completed/failed status
      // unconditionally regardless of timestamp precision
      void import("./lib/idb/IDBStore").then(({ setCursor }) => {
        void setCursor("downloads_cursor", new Date(0).toISOString());
      });
      syncNow();
    }
  }, [isDone]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleAddDownload = async (url: string, location: string, fileName?: string) => {
    setLoading(true);
    try {
      await createDownload(url, location, fileName);
      setIsModalOpen(false);
      syncNow();
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    const result = await deleteDownload(id);
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

        <DownloadList
          downloads={downloads}
          setDownloads={() => {}}
          downloadingFileId={downloadingFileId}
          progress={progress}
          onSelect={setSelectedId}
          onDelete={handleDelete}
          onEdit={setEditingFile}
        />

        {selectedDownload && (
          <DownloadDetails
            download={selectedDownload}
            isDownloading={downloadingFileId === selectedId}
            progress={downloadingFileId === selectedId ? progress : null}
            onClose={() => setSelectedId(null)}
          />
        )}
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
