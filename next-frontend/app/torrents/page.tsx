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
} from "../actions/torrents";
import type { FileDownload } from "../db/schema";
import type { IDBFileDownload } from "../lib/idb/schema";
import useTorrentService from "../service/torrentService";
import WorkerClient from "../lib/sync-worker/workerClient";
import { OfflineBanner } from "../components/OfflineBanner";
import {
  DownloadList,
  DownloadDetails,
  EditDownloadModal,
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
  const [editingFile, setEditingFile] = useState<FileDownload | null>(null);

  const { downloads: idbDownloads, networkStatus, syncNow } = useTorrents();
  const downloads = idbDownloads.map(toFileDownload);
  const { workers } = useWorkers({ enabled: isModalOpen });
  const client = useRef(WorkerClient.getInstance());

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
    if (downloadingFileId) { isFnEnd.current = true; return; }
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
        // Worker downloads: don't claim — worker picks up 'pending' via heartbeat
        setDownloadingFileId(targetFile.id);
      } else {
        // Non-worker: atomically claim before calling Express
        const claim = await claimTorrentDownload(targetFile.id);
        if (!claim.success) {
          // Another tab claimed it — just track
          setDownloadingFileId(targetFile.id);
          isFnEnd.current = true;
          return;
        }
        const { status, message } = await torrentService.startDownload(targetFile);
        if (!status) {
          console.log(message);
          await updateTorrentDownload(targetFile.id, { status: "pending" });
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

  useEffect(() => {
    if (downloads.length > 0) void startActiveDownload(downloads);
  }, [idbDownloads]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setIsModalOpen(false);
      syncNow();
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
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
  };

  const handleEditSubmit = async (
    id: string,
    data: { sourceUrl: string; fileName?: string; location: "server" | "mega" }
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

  return (
    <main className="min-h-screen bg-background p-4 md:p-6">
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
    </main>
  );
}
