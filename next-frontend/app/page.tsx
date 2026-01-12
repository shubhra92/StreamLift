"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProgress } from "./hooks/useProgress";
import { createDownload, getDownloads, deleteDownload, updateDownload } from "./actions/downloads";
import type { FileDownload } from "./db/schema";
import useHomeService from "./service/homeService";
import {
  DownloadList,
  DownloadDetails,
  AddDownloadModal,
  EditDownloadModal,
} from "./components/downloads";

export default function Home() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [downloads, setDownloads] = useState<FileDownload[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<FileDownload | null>(null);
  const homeService = useHomeService();
  const isFnEnd_fetchDownloads = useRef<boolean>(true)

  const { progress, isDone, error } = useProgress(downloadingFileId);

  const fetchDownloads = async () => {
    if(!isFnEnd_fetchDownloads.current) return null;
    isFnEnd_fetchDownloads.current = false

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
        // Refetch to get updated file size and status from server
        const updatedData = await getDownloads();
        setDownloads(updatedData);
      }
    } else if (targetFile) {
      setDownloadingFileId(targetFile.id);
    } else {
      setDownloadingFileId(null);
    }

    isFnEnd_fetchDownloads.current = true
  };

  //status Update On Download Not Found
  useEffect(() => {
    if (error === "Download not found") {
      (async () => {
        if (!downloadingFileId) return null

        await updateDownload(downloadingFileId, {
          status: "failed",
          errorMessage: "Download not found in server cache"
        })

        fetchDownloads()
      })()
    }
  }, [error])

  useEffect(() => {
    if (downloadingFileId === null || isDone) {
      fetchDownloads();
    }
  }, [isDone]);

  const handleAddDownload = async (url: string, location: "server" | "mega", fileName?: string) => {
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

  return (
    <main className="min-h-screen bg-background p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6"
        >
          <h1 className="text-xl md:text-2xl font-bold">Download Manager</h1>
          <Button onClick={() => setIsModalOpen(true)} className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 py-2 cursor-pointer">
            {/* <Plus className="h-4 w-4 mr-[5px]" /> */}
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
