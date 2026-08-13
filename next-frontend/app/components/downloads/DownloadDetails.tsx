"use client";

import { motion, AnimatePresence } from "motion/react";
import { X, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatFileSize, getStatusClass } from "./utils";
import { LocationLabel } from "./LocationLabel";
import type { DownloadDetailsProps } from "./types";

export function DownloadDetails({
  download,
  isDownloading,
  progress,
  onClose,
  panelRef,
}: DownloadDetailsProps) {
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <AnimatePresence>
      {download && (
        <>
          {/* Fixed bottom panel */}
          <motion.div
            key="panel"
            ref={panelRef}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 32, stiffness: 320 }}
            className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t shadow-2xl rounded-t-xl"
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-2">
              <div className="w-8 h-1 rounded-full bg-muted-foreground/25" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                File Details
              </h3>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
                <X className="h-3 w-3" />
              </Button>
            </div>

            {/* Progress bar (only while downloading) */}
            {isDownloading && progress && (
              <div className="px-4 py-2 border-b bg-muted/30">
                <div className="flex items-center gap-3">
                  <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded h-2">
                    <motion.div
                      className="bg-blue-500 h-2 rounded"
                      initial={{ width: 0 }}
                      animate={{ width: `${progress.percent || 0}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground shrink-0">
                    {progress.percentFixed2 || "0.00"}%
                  </span>
                </div>
              </div>
            )}

            {/* Detail rows — compact two-column grid */}
            <div className="px-4 py-2 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1 text-xs">
              <Row label="File Name" value={download.fileName || "-"} truncate />
              <Row label="File Size" value={download.fileSize ? formatFileSize(download.fileSize) : "-"} />
              <Row label="File Type" value={download.fileType || "-"} />
              <div className="flex items-center gap-2 py-1 border-b border-dashed border-muted">
                <span className="text-muted-foreground shrink-0">Status</span>
                <Badge className={`${getStatusClass(download.status)} text-[10px] px-1.5 py-0 h-4`}>
                  {download.status}
                </Badge>
              </div>
              <div className="flex items-center gap-2 py-1 border-b border-dashed border-muted col-span-2">
                <span className="text-muted-foreground shrink-0">Location</span>
                <span className="font-medium truncate">
                  <LocationLabel location={download.location} />
                </span>
              </div>
              <Row label="Location Path" value={download.locationPath || "-"} span={2} truncate />
              <Row label="Created" value={formatDate(download.createdAt)} />
              <Row label="Updated" value={formatDate(download.updatedAt)} />

              {/* Source URL spans full width */}
              <div className="col-span-2 md:col-span-4 flex items-start gap-2 py-1">
                <span className="text-muted-foreground shrink-0 mt-px">Source URL</span>
                <span className="font-medium truncate flex-1 text-blue-500" title={download.sourceUrl ?? ""}>
                  {download.sourceUrl}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 h-5 w-5"
                  onClick={() => copyToClipboard(download.sourceUrl)}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>

              {download.errorMessage && (
                <div className="col-span-2 md:col-span-4 flex items-start gap-2 py-1">
                  <span className="text-muted-foreground shrink-0">Error</span>
                  <span className="text-destructive font-medium">{download.errorMessage}</span>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function Row({
  label,
  value,
  truncate,
  span,
}: {
  label: string;
  value: string;
  truncate?: boolean;
  span?: number;
}) {
  return (
    <div
      className={`flex items-center gap-2 py-1 border-b border-dashed border-muted ${
        span === 2 ? "col-span-2" : ""
      }`}
    >
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`font-medium ${truncate ? "truncate" : ""}`} title={truncate ? value : undefined}>
        {value}
      </span>
    </div>
  );
}
