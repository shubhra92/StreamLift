"use client";

import { useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TorrentFileSelector } from "./TorrentFileSelector";
import { LocationSelect } from "../downloads/LocationSelect";
import { parseTorrentFile } from "@/app/lib/torrentParser";
import { Upload } from "lucide-react";

export interface SelectedFilesMeta {
  /** Display name: custom override or derived from selection */
  fileName: string;
  /** Total bytes of selected files */
  fileSize: number;
  /** File type of the primary selected file */
  fileType: string;
}

interface AddTorrentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (
    magnetLink: string,
    location: string,
    fileIndices: number[],
    meta: SelectedFilesMeta
  ) => Promise<void>;
  loading: boolean;
  workers?: { id: string; name: string; online: boolean }[];
}

interface TorrentFile {
  index: number;
  name: string;
  path: string;
  size: number;
  sizeFormatted: string;
  type: string;
}

interface TorrentMetadata {
  name: string;
  infoHash: string;
  totalSize: number;
  totalSizeFormatted: string;
  files: TorrentFile[];
  fileCount: number;
}

export function AddTorrentModal({
  isOpen,
  onClose,
  onSubmit,
  loading,
  workers = [],
}: AddTorrentModalProps) {
  const defaultLocation =
    process.env.NEXT_PUBLIC_SERVER_DOWNLOAD_ENABLED === "true" ? "server" : "mega";

  const [step, setStep] = useState<"input" | "select">("input");
  const [magnetLink, setMagnetLink] = useState("");
  const [fileNameOverride, setFileNameOverride] = useState("");
  const [location, setLocation] = useState(defaultLocation);
  const [metadata, setMetadata] = useState<TorrentMetadata | null>(null);
  const [fetchingMetadata, setFetchingMetadata] = useState(false);
  const [parsingFile, setParsingFile] = useState(false);
  const [fileError, setFileError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ------------------------------------------------------------------
  // .torrent file → auto-fill magnet link
  // ------------------------------------------------------------------
  const handleTorrentFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileError("");
    setParsingFile(true);
    try {
      const parsed = await parseTorrentFile(file);
      setMagnetLink(parsed.magnetLink);
    } catch {
      setFileError("Failed to parse .torrent file. Make sure it's a valid torrent.");
    } finally {
      setParsingFile(false);
      // Reset so the same file can be re-selected if needed
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // ------------------------------------------------------------------
  // Proceed to file selector via metadata API
  // ------------------------------------------------------------------
  const handleFetchMetadata = async () => {
    if (!magnetLink) return;

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

  // ------------------------------------------------------------------
  // Step 2 — file selection confirmed
  // ------------------------------------------------------------------
  const handleConfirmSelection = async (
    selectedIndices: number[],
    selectedFiles: TorrentFile[]
  ) => {
    const totalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);

    const derivedName =
      fileNameOverride.trim() ||
      (selectedFiles.length === 1 ? selectedFiles[0].name : metadata!.name);

    const derivedType = selectedFiles[0]?.type ?? "other";

    const meta: SelectedFilesMeta = {
      fileName: derivedName,
      fileSize: totalSize,
      fileType: derivedType,
    };

    await onSubmit(magnetLink, location, selectedIndices, meta);
    handleClose();
  };

  // ------------------------------------------------------------------
  // Reset
  // ------------------------------------------------------------------
  const handleClose = () => {
    setStep("input");
    setMagnetLink("");
    setFileNameOverride("");
    setFileError("");
    setLocation(defaultLocation);
    setMetadata(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
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
                {/* Label row with upload button */}
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm text-muted-foreground">
                    Magnet Link
                  </label>
                  <div className="flex items-center gap-2">
                    {parsingFile && (
                      <span className="text-xs text-muted-foreground">Parsing…</span>
                    )}
                    {/* Hidden file input */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".torrent"
                      onChange={handleTorrentFileChange}
                      className="sr-only"
                      id="torrent-file-input"
                    />
                    <label
                      htmlFor="torrent-file-input"
                      title="Use a .torrent file instead"
                      className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border rounded-md cursor-pointer transition-colors select-none ${
                        parsingFile
                          ? "opacity-50 pointer-events-none"
                          : "hover:bg-accent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {parsingFile ? (
                        <div className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      ) : (
                        <Upload className="h-3.5 w-3.5" />
                      )}
                      Browse .torrent
                    </label>
                  </div>
                </div>

                <textarea
                  placeholder="magnet:?xt=urn:btih:..."
                  value={magnetLink}
                  onChange={(e) => {
                    setMagnetLink(e.target.value);
                    setFileError("");
                  }}
                  rows={4}
                  className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none font-mono text-sm"
                />
                {fileError ? (
                  <p className="text-xs text-red-500 mt-1">{fileError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-1">
                    Paste your magnet link, or click &quot;Browse .torrent&quot; to convert a file
                  </p>
                )}
              </div>

              <div>
                <label className="text-sm text-muted-foreground mb-2 block">
                  File Name Override (optional)
                </label>
                <input
                  type="text"
                  placeholder="Leave blank to use torrent file name"
                  value={fileNameOverride}
                  onChange={(e) => setFileNameOverride(e.target.value)}
                  className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div>
                <label className="text-sm text-muted-foreground mb-2 block">
                  Storage Location
                </label>
                <LocationSelect value={location} onChange={setLocation} workers={workers} />
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
                  disabled={fetchingMetadata || parsingFile || !magnetLink}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 cursor-pointer"
                >
                  {fetchingMetadata ? "Fetching Files…" : "Next: Select Files"}
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
