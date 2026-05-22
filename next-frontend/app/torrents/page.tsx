"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { useProgress } from "../hooks/useProgress";
import { createTorrentDownload, getTorrentDownloads, deleteTorrentDownload, updateTorrentDownload } from "../actions/torrents";
import type { FileDownload } from "../db/schema";
import useTorrentService from "../service/torrentService";
import {
  DownloadList,
  DownloadDetails,
  EditDownloadModal,
} from "../components/downloads";
import { AddTorrentModal } from "../components/torrents/AddTorrentModal";

export default function TorrentsPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [downloads, setDownloads] = useState<FileDownload[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<FileDownload | null>(null);
  const torrentService = useTorrentService();
  const isFnEnd_fetchDownloads = useRef<boolean>(true);
  const isDBCallHapping = useRef<boolean>(false);

  const { progress, isDone, error } = useProgress(downloadingFileId);

  const fetchDownloads = async () => {
    if (!isFnEnd_fetchDownloads.current) return null;
    isFnEnd_fetchDownloads.current = false;

    const data = await getTorrentDownloads();

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
      // Parse stored file indices from database
      const fileIndices = targetFile.selectedFileIndices 
        ? JSON.parse(targetFile.selectedFileIndices as string)
        : undefined;
      
      const { status, message } = await torrentService.startDownload(targetFile, fileIndices);
      if (!status) {
        console.log(message);
      } else {
        setDownloadingFileId(targetFile.id);
        // Refetch to get updated file size and status from server
        const updatedData = await getTorrentDownloads();
        setDownloads(updatedData);
      }
    } else if (targetFile) {
      setDownloadingFileId(targetFile.id);
    } else {
      setDownloadingFileId(null);
    }

    isFnEnd_fetchDownloads.current = true;
  };

  // Status Update On Download Not Found
  useEffect(() => {
    if (error === "Download not found") {
      (async () => {
        if (!downloadingFileId || isDBCallHapping.current) return null;

        isDBCallHapping.current = true;
        await updateTorrentDownload(downloadingFileId, {
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
      console.log('📥 Refetching downloads - isDone:', isDone, 'downloadingFileId:', downloadingFileId);
      fetchDownloads();
    }
  }, [isDone]);

  const handleAddDownload = async (
    magnetLink: string,
    location: "server" | "mega",
    fileName?: string,
    fileIndices?: number[]
  ) => {
    setLoading(true);
    try {
      await createTorrentDownload(magnetLink, location, fileName, fileIndices);
      setIsModalOpen(false);
      fetchDownloads();
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    const result = await deleteTorrentDownload(id);
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
      const result = await updateTorrentDownload(id, data);
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

  return (
    <main className="min-h-screen bg-background p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
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

      <AddTorrentModal
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
