"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Download, Magnet } from "lucide-react";
import { HttpDownloadForm } from "./HttpDownloadForm";
import { TorrentDownloadForm } from "../torrents/TorrentDownloadForm";
import type { SelectedFilesMeta } from "../torrents/AddTorrentModal";

type Tab = "http" | "torrent";

export interface AddUnifiedModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddHttp: (
    sourceUrl: string,
    location: string,
    fileName?: string,
    fileSize?: number | null,
    fileType?: string | null
  ) => Promise<void>;
  onAddTorrent: (
    magnetLink: string,
    location: string,
    fileIndices: number[],
    meta: SelectedFilesMeta
  ) => Promise<void>;
  loading: boolean;
  workers?: { id: string; name: string; online: boolean }[];
}

export function AddUnifiedModal({
  isOpen,
  onClose,
  onAddHttp,
  onAddTorrent,
  loading,
  workers = [],
}: AddUnifiedModalProps) {
  const [tab, setTab] = useState<Tab>("http");

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Download</DialogTitle>
          <DialogDescription>
            Add an HTTP URL or torrent/magnet link.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2 p-1 bg-muted rounded-md mb-4">
          <button
            type="button"
            onClick={() => setTab("http")}
            className={`flex items-center gap-2 flex-1 px-3 py-2 rounded-sm text-sm font-medium transition-colors ${
              tab === "http"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Download className="h-4 w-4" />
            HTTP
          </button>
          <button
            type="button"
            onClick={() => setTab("torrent")}
            className={`flex items-center gap-2 flex-1 px-3 py-2 rounded-sm text-sm font-medium transition-colors ${
              tab === "torrent"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Magnet className="h-4 w-4" />
            Torrent
          </button>
        </div>

        {tab === "http" && (
          <HttpDownloadForm
            onSubmit={onAddHttp}
            onCancel={onClose}
            loading={loading}
            workers={workers}
          />
        )}
        {tab === "torrent" && (
          <TorrentDownloadForm
            onSubmit={onAddTorrent}
            onCancel={onClose}
            loading={loading}
            workers={workers}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
