"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TorrentFileSelector } from "./TorrentFileSelector";

interface AddTorrentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (magnetLink: string, location: "server" | "mega", fileName?: string, fileIndices?: number[]) => Promise<void>;
  loading: boolean;
}

interface TorrentMetadata {
  name: string;
  infoHash: string;
  totalSize: number;
  totalSizeFormatted: string;
  files: any[];
  fileCount: number;
}

export function AddTorrentModal({
  isOpen,
  onClose,
  onSubmit,
  loading,
}: AddTorrentModalProps) {
  const [step, setStep] = useState<"input" | "select">("input");
  const [magnetLink, setMagnetLink] = useState("");
  const [fileName, setFileName] = useState("");
  const [location, setLocation] = useState<"server" | "mega">("mega");
  const [metadata, setMetadata] = useState<TorrentMetadata | null>(null);
  const [fetchingMetadata, setFetchingMetadata] = useState(false);

  const handleFetchMetadata = async () => {
    if (!magnetLink) return;
    
    // Validate magnet link format
    if (!magnetLink.startsWith("magnet:?")) {
      alert("Please enter a valid magnet link (starts with magnet:?)");
      return;
    }

    setFetchingMetadata(true);
    try {
      const response = await fetch("/api/torrent-download/metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ magnet_link: magnetLink }),
      });

      const result = await response.json();
      
      if (!result.status) {
        alert(result.message || "Failed to fetch torrent metadata");
        return;
      }

      setMetadata(result.data);
      setStep("select");
    } catch (error: any) {
      alert(error.message || "Failed to fetch metadata");
    } finally {
      setFetchingMetadata(false);
    }
  };

  const handleConfirmSelection = async (selectedIndices: number[]) => {
    await onSubmit(magnetLink, location, fileName || undefined, selectedIndices);
    handleClose();
  };

  const handleClose = () => {
    setStep("input");
    setMagnetLink("");
    setFileName("");
    setLocation("mega");
    setMetadata(null);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === "input" ? "Add New Torrent" : "Select Files to Download"}
          </DialogTitle>
        </DialogHeader>
        
        <AnimatePresence mode="wait">
          {step === "input" ? (
            <motion.div
              key="input"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="space-y-4"
            >
              <div>
                <label className="text-sm text-muted-foreground mb-2 block">
                  Magnet Link
                </label>
                <textarea
                  placeholder="magnet:?xt=urn:btih:..."
                  value={magnetLink}
                  onChange={(e) => setMagnetLink(e.target.value)}
                  rows={4}
                  className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Paste your magnet link here
                </p>
              </div>

              <div>
                <label className="text-sm text-muted-foreground mb-2 block">
                  File Name (Optional)
                </label>
                <input
                  type="text"
                  placeholder="my-file.mp4"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div>
                <label className="text-sm text-muted-foreground mb-2 block">
                  Storage Location
                </label>
                <select
                  value={location}
                  onChange={(e) => setLocation(e.target.value as "server" | "mega")}
                  className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="server">Server</option>
                  <option value="mega">Mega (Recommended)</option>
                </select>
                <p className="text-xs text-muted-foreground mt-1">
                  MEGA recommended for persistent storage
                </p>
              </div>

              <div className="flex flex-col-reverse sm:flex-row gap-3">
                <Button
                  variant="outline"
                  onClick={handleClose}
                  className="flex-1 cursor-pointer"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleFetchMetadata}
                  disabled={fetchingMetadata || !magnetLink}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 cursor-pointer"
                >
                  {fetchingMetadata ? "Fetching Files..." : "Next: Select Files"}
                </Button>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="select"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
            >
              {metadata && (
                <TorrentFileSelector
                  metadata={metadata}
                  onConfirm={handleConfirmSelection}
                  onCancel={() => setStep("input")}
                  loading={loading}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
