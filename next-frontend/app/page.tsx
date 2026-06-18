"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { useProgress } from "./hooks/useProgress";
import { useWorkerProgress } from "./hooks/useWorkerProgress";
import { createDownload, getDownloads, deleteDownload, updateDownload } from "./actions/downloads";
import type { FileDownload } from "./db/schema";
import useHomeService from "./service/homeService";
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

export default function Home() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [downloads, setDownloads] = useState<FileDownload[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<FileDownload | null>(null);
  const homeService = useHomeService();
  const isFnEnd_fetchDownloads = useRef<boolean>(true);
  const isDBCallHapping = useRef<boolean>(false);
  const workerPollRef = useRef<NodeJS.Timeout | null>(null);

  // Determine if the active download is a worker download
  const activeDownload = downloads.find((d) => d.id === downloadingFileId);
  const isWorkerDownload = isWorkerLocation(activeDownload?.location);

  // Express SSE/polling — only for server/mega downloads
  const { progress: expressProgress, isDone: expressIsDone, error: expressError } = useProgress(
    isWorkerDownload ? null : downloadingFileId
  );

  // Worker store polling — only for worker downloads
  const { progress: workerProgress, isDone: workerIsDone } = useWorkerProgress(
    isWorkerDownload ? (activeDownload?.workerId ?? null) : null,
    isWorkerDownload ? downloadingFileId : null,
    3000
  );

  // Unified progress and isDone for the UI
  const progress = isWorkerDownload ? workerProgress : expressProgress;
  const isDone   = isWorkerDownload ? workerIsDone   : expressIsDone;
  const error    = isWorkerDownload ? null            : expressError;

  // Poll DB every 5s for worker downloads to detect completion/failure
  useEffect(() => {
    if (isWorkerDownload && downloadingFileId) {
      if (workerPollRef.current) clearInterval(workerPollRef.current);
      workerPollRef.current = setInterval(async () => {
        const data = await getDownloads();
        setDownloads(data);
        const target = data.find((d) => d.id === downloadingFileId);
        if (!target || target.status === "completed" || target.status === "failed") {
          clearInterval(workerPollRef.current!);
          workerPollRef.current = null;
          setDownloadingFileId(null);
        }
      }, 5000);
    } else {
      if (workerPollRef.current) {
        clearInterval(workerPollRef.current);
        workerPollRef.current = null;
      }
    }
    return () => {
      if (workerPollRef.current) clearInterval(workerPollRef.current);
    };
  }, [isWorkerDownload, downloadingFileId]);

  const fetchDownloads = async () => {
    if (!isFnEnd_fetchDownloads.current) return null;
    isFnEnd_fetchDownloads.current = false;

    const data = await getDownloads();
    setDownloads(data);

    let targetFile = null;
    const targetStatus = new Set(["downloading", "pending"]);

    for (const f of data) {
      if (!targetStatus.has(f.status!)) continue;

      if (f.status === "downloading") {
        targetFile = f;
        break;
      }
      if (!targetFile) {
        targetFile = f;
        continue;
      }

      const isOlder = new Date(f.updatedAt!) < new Date(targetFile.updatedAt!);
      if (isOlder) {
        targetFile = f;
      }
    }

    if (targetFile?.status === "pending") {
      const { status, message } = await homeService.startDownload(targetFile);
      if (!status) {
        console.log(message);
      } else {
        setDownloadingFileId(targetFile.id);
        // For non-worker downloads, refetch to get updated file size from Express
        if (!isWorkerLocation(targetFile.location)) {
          const updatedData = await getDownloads();
          setDownloads(updatedData);
        }
      }
    } else if (targetFile) {
      setDownloadingFileId(targetFile.id);
    } else {
      setDownloadingFileId(null);
    }

    isFnEnd_fetchDownloads.current = true;
  };

  // Handle Express "Download not found" error (non-worker only)
  useEffect(() => {
    if (error === "Download not found") {
      (async () => {
        if (!downloadingFileId || isDBCallHapping.current) return null;
        isDBCallHapping.current = true;
        await updateDownload(downloadingFileId, {
          status: "failed",
          errorMessage: "Download not found in server cache",
        });
        isDBCallHapping.current = false;
        fetchDownloads();
      })();
    }
  }, [error]);

  useEffect(() => {
    if (downloadingFileId === null || isDone) {
      fetchDownloads();
    }
  }, [isDone]);

  const handleAddDownload = async (url: string, location: string, fileName?: string) => {
    setLoading(true);
    try {
      await createDownload(url, location, fileName);
      setIsModalOpen(false);
      fetchDownloads();
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    const result = await deleteDownload(id);
    if (result.success) {
      fetchDownloads();
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
        fetchDownloads();
      } else {
        alert(result.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const selectedDownload = downloads.find((d) => d.id === selectedId);
  const selectedIsWorker = isWorkerLocation(selectedDownload?.location);

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

        <DownloadList
          downloads={downloads}
          setDownloads={setDownloads}
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
