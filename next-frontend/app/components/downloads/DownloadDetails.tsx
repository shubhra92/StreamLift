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
}: DownloadDetailsProps) {
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.2 }}
        className="my-4 bg-card p-4 md:p-5 rounded-xl shadow-md border"
      >
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-lg font-semibold">File Details</h3>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <DetailItem label="File Name" value={download.fileName || "-"} />
          <DetailItem
            label="File Size"
            value={download.fileSize ? formatFileSize(download.fileSize) : "-"}
          />
          <DetailItem label="File Type" value={download.fileType || "-"} />
          <div>
            <p className="text-muted-foreground text-xs mb-1">Status</p>
            <Badge className={getStatusClass(download.status)}>
              {download.status}
            </Badge>
          </div>

          {/* Location — resolves worker-{id} to worker name */}
          <div>
            <p className="text-muted-foreground text-xs mb-1">Location</p>
            <p className="font-medium">
              <LocationLabel location={download.location} />
            </p>
          </div>

          <DetailItem label="Location Path" value={download.locationPath || "-"} breakAll />
          <DetailItem label="Created At" value={formatDate(download.createdAt)} />
          <DetailItem label="Updated At" value={formatDate(download.updatedAt)} />

          <div className="col-span-1 sm:col-span-2">
            <p className="text-muted-foreground text-xs mb-1">Source URL</p>
            <div className="flex items-start gap-2">
              <p className="font-medium break-all text-xs flex-1">{download.sourceUrl}</p>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 h-6 w-6 cursor-pointer"
                onClick={() => copyToClipboard(download.sourceUrl)}
              >
                <Copy className="h-3 w-3" />
              </Button>
            </div>
          </div>

          {download.errorMessage && (
            <div className="col-span-1 sm:col-span-2">
              <p className="text-muted-foreground text-xs mb-1">Error</p>
              <p className="text-destructive font-medium">{download.errorMessage}</p>
            </div>
          )}
        </div>

        {isDownloading && progress && (
          <div className="mt-4 pt-4 border-t">
            <p className="text-sm text-muted-foreground mb-2">
              Download Progress: {progress.percentFixed2 || "0.00"}%
            </p>
            <div className="w-full bg-gray-200 rounded h-3">
              <motion.div
                className="bg-green-600 h-3 rounded"
                initial={{ width: 0 }}
                animate={{ width: `${progress.percent || 0}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}

function DetailItem({
  label,
  value,
  className,
  breakAll,
}: {
  label: string;
  value: string;
  className?: string;
  breakAll?: boolean;
}) {
  return (
    <div>
      <p className="text-muted-foreground text-xs mb-1">{label}</p>
      <p className={`font-medium ${breakAll ? "break-all" : ""} ${className || ""}`}>
        {value}
      </p>
    </div>
  );
}
