"use client";

import { useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@/components/ui/button";
import { TorrentFileSelector } from "./TorrentFileSelector";
import { LocationSelect, locationName, locationDotClass } from "../downloads/LocationSelect";
import { getWorkerTorrentMetadata } from "@/app/lib/workerConnection";
import { parseTorrentFile } from "@/app/lib/torrentParser";
import { Upload } from "lucide-react";
import type { SelectedFilesMeta } from "@/app/components/torrents/AddTorrentModal";

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

export interface TorrentDownloadFormProps {
  onSubmit: (
    magnetLink: string,
    location: string,
    fileIndices: number[],
    meta: SelectedFilesMeta
  ) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
  workers?: { id: string; name: string; online: boolean }[];
}

export function TorrentDownloadForm({
  onSubmit,
  onCancel,
  loading,
  workers = [],
}: TorrentDownloadFormProps) {
  const defaultLocation =
    process.env.NEXT_PUBLIC_SERVER_DOWNLOAD_ENABLED === "true" ? "server" : "cloud";

  const [step, setStep] = useState<"input" | "select">("input");
  const [magnetLink, setMagnetLink] = useState("");
  const [fileNameOverride, setFileNameOverride] = useState("");
  const [location, setLocation] = useState(defaultLocation);
  const [metadata, setMetadata] = useState<TorrentMetadata | null>(null);
  const [fetchingMetadata, setFetchingMetadata] = useState(false);
  const [parsingFile, setParsingFile] = useState(false);
  const [fileError, setFileError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const workerId = location.startsWith("worker-") ? location.slice("worker-".length) : null;
  const worker = workerId ? workers.find((w) => w.id === workerId) : undefined;

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
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleFetchMetadata = async () => {
    if (!magnetLink) return;
    if (!magnetLink.startsWith("magnet:?")) {
      alert("Please enter a valid magnet link (starts with magnet:?)");
      return;
    }

    setFetchingMetadata(true);
    try {
      let result: { status: boolean; message: string; data?: any };
      if (workerId && worker?.online) {
        result = await getWorkerTorrentMetadata(workerId, magnetLink);
      } else {
        const response = await fetch("/api/torrent-download/metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ magnet_link: magnetLink }),
        });
        result = await response.json();
      }

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

  const handleClose = () => {
    setStep("input");
    setMagnetLink("");
    setFileNameOverride("");
    setFileError("");
    setLocation(defaultLocation);
    setMetadata(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    onCancel();
  };

  return (
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
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-muted-foreground">
                Magnet Link
              </label>
              <div className="flex items-center gap-2">
                {parsingFile && (
                  <span className="text-xs text-muted-foreground">Parsing…</span>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".torrent"
                  onChange={handleTorrentFileChange}
                  className="sr-only"
                  id="torrent-file-input-form"
                />
                <label
                  htmlFor="torrent-file-input-form"
                  title="Use a .torrent file instead"
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border rounded-md cursor-pointer transition-colors select-none ${
                    parsingFile ? "opacity-50 pointer-events-none" : "hover:bg-accent text-muted-foreground hover:text-foreground"
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
                Paste your magnet link, or click "Browse .torrent" to convert a file
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">Download location</label>
            <LocationSelect value={location} onChange={setLocation} workers={workers} />
            {workerId && !worker?.online && (
              <p className="text-xs text-muted-foreground">
                Worker offline — fetching metadata via server instead.
              </p>
            )}
          </div>

          <div className="flex flex-col-reverse sm:flex-row gap-3">
            <Button
              variant="outline"
              onClick={handleClose}
              className="flex-1 cursor-pointer"
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleFetchMetadata}
              disabled={fetchingMetadata || parsingFile || !magnetLink || loading}
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
          className="space-y-4"
        >
          {metadata && (
            <TorrentFileSelector
              metadata={metadata}
              fileNameOverride={fileNameOverride}
              onFileNameOverrideChange={setFileNameOverride}
              locationName={locationName(location, workers)}
              locationDotClass={locationDotClass(location, workers)}
              onConfirm={(indices, files) => {
                const totalSize = files.reduce((sum, f) => sum + f.size, 0);
                const derivedName =
                  fileNameOverride.trim() ||
                  (files.length === 1 ? files[0].name : metadata.name);
                const derivedType = files[0]?.type ?? "other";
                const meta: SelectedFilesMeta = {
                  fileName: derivedName,
                  fileSize: totalSize,
                  fileType: derivedType,
                };
                onSubmit(magnetLink, location, indices, meta);
                handleClose();
              }}
              onCancel={() => setStep("input")}
              loading={loading}
            />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
