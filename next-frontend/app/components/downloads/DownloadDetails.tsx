"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  X, Copy, Check,
  FileVideo, FileAudio, FileImage, FileArchive,
  FileText, FileCode, Folder, File,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatFileSize, getStatusClass } from "./utils";
import { LocationLabel } from "./LocationLabel";
import type { DownloadDetailsProps } from "./types";

// ── File-type icon helper ────────────────────────────────────────────────────
function FileTypeIcon({ mimeType, className }: { mimeType: string | null | undefined; className?: string }) {
  const cls = className ?? "h-16 w-16";

  if (!mimeType) return <File className={`${cls} text-muted-foreground`} />;

  if (mimeType === "multi" || mimeType.includes("zip") || mimeType.includes("tar") ||
      mimeType.includes("rar") || mimeType.includes("7z") || mimeType.includes("archive"))
    return <FileArchive className={`${cls} text-yellow-500`} />;

  if (mimeType.startsWith("video/"))
    return <FileVideo className={`${cls} text-blue-500`} />;

  if (mimeType.startsWith("audio/"))
    return <FileAudio className={`${cls} text-purple-500`} />;

  if (mimeType.startsWith("image/"))
    return <FileImage className={`${cls} text-green-500`} />;

  if (mimeType.includes("pdf") || mimeType.startsWith("text/"))
    return <FileText className={`${cls} text-orange-500`} />;

  if (mimeType.includes("javascript") || mimeType.includes("json") ||
      mimeType.includes("html") || mimeType.includes("css") || mimeType.includes("xml"))
    return <FileCode className={`${cls} text-cyan-500`} />;

  if (mimeType === "directory" || mimeType === "folder")
    return <Folder className={`${cls} text-yellow-400`} />;

  return <File className={`${cls} text-muted-foreground`} />;
}

// ── Compact label: value row ──────────────────────────────────────────────────
function Row({
  label,
  value,
  truncate,
  span,
  children,
}: {
  label: string;
  value?: string;
  truncate?: boolean;
  span?: number;
  children?: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-0.5 min-w-0 ${span === 2 ? "col-span-2" : ""}`}>
      <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{label}</span>
      {children ?? (
        <span
          className={`font-medium text-sm ${truncate ? "truncate" : "break-all"}`}
          title={truncate && value ? value : undefined}
        >
          {value ?? "-"}
        </span>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function DownloadDetails({
  download,
  isDownloading,
  progress,
  onClose,
  panelRef,
}: DownloadDetailsProps) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <AnimatePresence>
      {download && (
        <motion.div
          key="panel"
          ref={panelRef}
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 32, stiffness: 320 }}
          className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t shadow-2xl rounded-t-xl
                     max-h-[70vh] overflow-y-auto"
        >
          {/* Drag handle */}
          <div className="flex justify-center pt-2 pb-1 sticky top-0 bg-card z-10">
            <div className="w-8 h-1 rounded-full bg-muted-foreground/25" />
          </div>

          {/* Header bar */}
          <div className="flex items-center justify-between px-4 pb-2 pt-1 border-b sticky top-5 bg-card z-10">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              File Details
            </h3>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
              <X className="h-3 w-3" />
            </Button>
          </div>

          {/* Body: icon + details side by side */}
          <div className="flex items-stretch gap-5 px-4 pt-3 pb-5">
            {/* Left: big file-type icon — vertically centered, fixed minimum height */}
            <div className="hidden sm:flex shrink-0 flex-col items-center justify-center w-28 md:w-36
                            min-h-[160px] md:min-h-[180px]
                            bg-muted/40 rounded-xl border border-dashed border-muted-foreground/20">
              <FileTypeIcon mimeType={download.fileType} className="h-16 w-16 md:h-24 md:w-24 lg:h-28 lg:w-28" />
              <span className="mt-2 text-xs text-muted-foreground text-center font-mono font-semibold tracking-widest">
                {download.fileType?.split("/")[1]?.toUpperCase() ?? "FILE"}
              </span>
            </div>

            {/* Right: detail grid */}
            <div className="flex-1 min-w-0 flex flex-col gap-3">
              {/* File name — prominent, like FDM */}
              <p className="text-lg font-semibold leading-snug line-clamp-2" title={download.fileName ?? undefined}>
                {download.fileName || "-"}
              </p>

              {/* Progress bar — right below title, only while downloading */}
              {isDownloading && progress && (
                <div className="flex items-center gap-3">
                  <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded h-4">
                    <motion.div
                      className="bg-green-600 h-4 rounded"
                      initial={{ width: 0 }}
                      animate={{ width: `${progress.percent || 0}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                  <span className="text-sm tabular-nums text-muted-foreground shrink-0 font-medium">
                    {progress.percentFixed2 || "0.00"}%
                  </span>
                </div>
              )}

              {/* Main metadata grid */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-4 text-xs">
                <Row label="File Size" value={download.fileSize ? formatFileSize(download.fileSize) : "-"} />
                <Row label="File Type" value={download.fileType || "-"} />
                <Row label="Status">
                  <Badge className={`${getStatusClass(download.status)} text-xs px-1.5 py-0 h-5`}>
                    {download.status}
                  </Badge>
                </Row>
                <Row label="Location">
                  <span className="font-medium text-sm truncate">
                    <LocationLabel location={download.location} />
                  </span>
                </Row>
                <Row label="Created" value={formatDate(download.createdAt)} />
                <Row label="Updated" value={formatDate(download.updatedAt)} />
                <Row label="Location Path" value={download.locationPath || "-"} span={2} truncate />
              </div>

              {/* Source URL — full row */}
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Source URL</span>
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="text-sm font-medium text-blue-500 truncate flex-1"
                    title={download.sourceUrl ?? ""}
                  >
                    {download.sourceUrl}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 h-6 w-6 cursor-pointer"
                    onClick={() => copyToClipboard(download.sourceUrl)}
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      {copied ? (
                        <motion.span
                          key="check"
                          initial={{ scale: 0, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0, opacity: 0 }}
                          transition={{ duration: 0.15 }}
                        >
                          <Check className="h-3.5 w-3.5 text-green-500" />
                        </motion.span>
                      ) : (
                        <motion.span
                          key="copy"
                          initial={{ scale: 0, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0, opacity: 0 }}
                          transition={{ duration: 0.15 }}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </Button>
                </div>
              </div>

              {/* Error message */}
              {download.errorMessage && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Error</span>
                  <span className="text-sm text-destructive font-medium">{download.errorMessage}</span>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
