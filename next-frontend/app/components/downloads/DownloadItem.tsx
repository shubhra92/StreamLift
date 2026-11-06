"use client";

import { motion } from "motion/react";
import { Check, Download, Trash2, Pencil, Loader2, Link, MonitorPlay, MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getFileExtension, isNativePlayable } from "@/app/lib/media";
import { formatDate, formatFileSize, getStatusClass, getStatusVariant, getTypeClass, getTypeLabel } from "./utils";

const NATIVE_CLOUD_MIME_TYPES = new Set([
  "video/mp4",
  "video/x-m4v",
  "video/webm",
  "video/quicktime",
  "video/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/flac",
  "audio/ogg",
  "audio/opus",
]);
import type { DownloadItemProps } from "./types";
import { LocationLabel } from "./LocationLabel";
import { DownloadingIcon, GlobeDownload } from "@/components/ui/custom-icons";

export function DownloadItem({
  download,
  isDownloading,
  isDeleting,
  isSelected,
  progress,
  onSelect,
  onDelete,
  onEdit,
  workerFiles = [],
  onDownloadWorkerFile,
  onDownloadWorkerFileExternalLink,
  workerFileTransfer,
  onCreateShareLink,
  onCloudExternalLink,
  onCloudTabDownload,
  isCreatingLink,
  watchDownloadIds,
  onAddToWatch,
  isAddingToWatch,
  onlineWorkerIds,
  selectionMode = false,
  isChecked = false,
  onToggleChecked,
}: DownloadItemProps) {
  const canEdit = download.status === "pending";
  const canDelete = download.status !== "downloading" && !isDownloading;
  const canSelect = canDelete;
  const canDownload = download.status === "completed" && workerFiles.length > 0 && !!onDownloadWorkerFile;
  const isCloudUpload = download.status === "completed" && !!download.cloudFileHandle && workerFiles.length === 0;
  const hasShareUrl = !!download.cloudShareUrl;
  // Worker-owned rows can only mint a link while the owning worker is online
  // (it holds the MEGA node session). Once created, the persisted share URL
  // works forever — external/download options are unconditional.
  const workerShareAvailable = !download.workerId || (onlineWorkerIds?.has(download.workerId) ?? false);
  const canCreateShareLink = isCloudUpload && !hasShareUrl && workerShareAvailable;
  const isInWatch = watchDownloadIds?.has(download.id) ?? false;
  // Show the action whenever a share link exists, but only enable it for
  // containers the browser can actually play. Unknown/no extension is left
  // enabled so the server can inspect the real cloud name and decide.
  const visibleWatchAction = isCloudUpload && hasShareUrl && !!onAddToWatch;
  const watchName = download.fileName ?? "";
  const hasKnownExtension = getFileExtension(watchName) !== "";
  const watchFormatPlayable =
    isNativePlayable(watchName) ||
    NATIVE_CLOUD_MIME_TYPES.has((download.fileType ?? "").toLowerCase()) ||
    !hasKnownExtension;
  const canAddToWatch = visibleWatchAction && watchFormatPlayable;
  const transferPercent = workerFileTransfer?.totalBytes
    ? Math.min(100, Math.round((workerFileTransfer.receivedBytes / workerFileTransfer.totalBytes) * 100))
    : null;
  const hasActions = canEdit || canDelete || canDownload || isCloudUpload;

  // Async items call e.preventDefault() in onSelect so the menu stays open
  // while the action runs (Radix closes on select by default). Outside click,
  // Esc, or the trigger still dismiss it.
  const actionsMenu = !selectionMode && hasActions ? (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="More actions"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical className="h-4 w-4 text-muted-foreground" />
          <span className="sr-only">More actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {canEdit && (
          <DropdownMenuItem onSelect={() => onEdit(download)}>
            <Pencil className="h-4 w-4" />
            Edit
          </DropdownMenuItem>
        )}
        {canDownload && (
          <>
            <DropdownMenuItem onSelect={() => onDownloadWorkerFileExternalLink?.(download, workerFiles)}>
              <GlobeDownload className="h-4 w-4" />
              Download via external link
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!!workerFileTransfer}
              onSelect={() => onDownloadWorkerFile?.(download, workerFiles)}
            >
              {workerFileTransfer
                ? <DownloadingIcon color="#2563EB" />
                : <Download className="h-4 w-4" />}
              {workerFileTransfer
                ? `Downloading${transferPercent !== null ? ` — ${transferPercent}%` : ""}`
                : "Download from worker"}
            </DropdownMenuItem>
          </>
        )}
        {isCloudUpload && (canCreateShareLink || hasShareUrl) && (
          <DropdownMenuItem
            disabled={!hasShareUrl && isCreatingLink}
            onSelect={(e) => {
              e.preventDefault();
              if (hasShareUrl) {
                onCloudExternalLink?.(download);
                return;
              }
              if (isCreatingLink) return;
              onCreateShareLink?.(download);
            }}
          >
            {hasShareUrl
              ? <GlobeDownload className="h-4 w-4" />
              : isCreatingLink
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Link className="h-4 w-4" />}
            {hasShareUrl
              ? "Open share link"
              : isCreatingLink
                ? "Creating share link…"
                : "Create share link"}
          </DropdownMenuItem>
        )}
        {isCloudUpload && hasShareUrl && (
          <DropdownMenuItem
            disabled={!!workerFileTransfer}
            onSelect={() => onCloudTabDownload?.(download)}
          >
            {workerFileTransfer
              ? <DownloadingIcon color="#2563EB" />
              : <Download className="h-4 w-4" />}
            {workerFileTransfer
              ? `Downloading${transferPercent !== null ? ` — ${transferPercent}%` : ""}`
              : "Download from cloud"}
          </DropdownMenuItem>
        )}
        {visibleWatchAction && (
          <DropdownMenuItem
            disabled={isAddingToWatch || isInWatch || !canAddToWatch}
            title={
              !watchFormatPlayable
                ? "This format is not browser-playable. Watch supports MP4/M4V/WebM/MOV/OGV and common audio formats."
                : undefined
            }
            onSelect={(e) => {
              e.preventDefault();
              if (isInWatch || isAddingToWatch || !canAddToWatch) return;
              onAddToWatch?.(download);
            }}
          >
            {isAddingToWatch
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : isInWatch
                ? <Check className="h-4 w-4" />
                : <MonitorPlay className="h-4 w-4" />}
            {isAddingToWatch
              ? "Adding to Watch…"
              : isInWatch
                ? "Already on Watch page"
                : "Add to Watch page"}
          </DropdownMenuItem>
        )}
        {canDelete && (canEdit || canDownload || isCloudUpload) && <DropdownMenuSeparator />}
        {canDelete && (
          <DropdownMenuItem
            variant="destructive"
            disabled={isDeleting}
            onSelect={(e) => {
              e.preventDefault();
              if (isDeleting) return;
              onDelete(download.id);
            }}
          >
            {isDeleting
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Trash2 className="h-4 w-4" />}
            {isDeleting ? "Deleting…" : "Delete"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  const selectCheckbox = (
    <Checkbox
      checked={isChecked}
      disabled={!canSelect || isDeleting}
      onClick={(e) => e.stopPropagation()}
      onCheckedChange={() => onToggleChecked?.(download.id)}
      title={!canSelect ? "Cannot select a file that is downloading" : undefined}
      aria-label={`Select ${download.fileName || "download"}`}
    />
  );

  return (
    <motion.tr
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      className={`hover:bg-muted/50 cursor-pointer border-b transition-colors ${
        isSelected ? "bg-blue-50/50 dark:bg-blue-950/20" : ""
      }`}
      onClick={() => {
        if (selectionMode) {
          if (canSelect) onToggleChecked?.(download.id);
          return;
        }
        onSelect(download.id);
      }}
    >
      {/* Mobile Card View */}
      <TableCell className="p-3 md:hidden" colSpan={selectionMode ? 8 : 7}>
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            {selectionMode && <div className="shrink-0 pt-0.5">{selectCheckbox}</div>}
            <p className="font-medium text-sm truncate flex-1">
              {download.fileName || "-"}
            </p>
            {actionsMenu && (
              <div className="flex items-center shrink-0">{actionsMenu}</div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{download.fileSize ? formatFileSize(download.fileSize) : "-"}</span>
            <span>•</span>
            <span className="capitalize">{download.downloadType === "torrent" ? "Torrent" : download.downloadType === "hls" ? "HLS" : "HTTP"}</span>
            <span>•</span>
            <span className="capitalize"><LocationLabel location={download.location} /></span>
          </div>
          {isDownloading && !!progress ? (
            <div className="w-full bg-gray-200 rounded h-2"> {/* bg-gray-200 <= bg-muted */}
              <motion.div
                className="bg-green-600 h-2 rounded"
                initial={{ width: 0 }}
                animate={{ width: `${progress?.percent ?? 0}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
          ) : (
            <div className="flex items-center">
              <Badge
                // variant={getStatusVariant(download.status)}
                className={getStatusClass(download.status)}
              >
                {download.status}
              </Badge>
            </div>
          )}
        </div>
      </TableCell>

      {/* Desktop Table View */}
      {selectionMode && (
        <TableCell className="hidden md:table-cell px-3 py-3 w-12">
          {selectCheckbox}
        </TableCell>
      )}
      {/* File name: min-w-0 lets the cell shrink; overflow+truncate clips long names */}
      <TableCell className="hidden md:table-cell px-4 py-3 text-sm min-w-0">
        <span className="block truncate" title={download.fileName || undefined}>
          {download.fileName || "-"}
        </span>
      </TableCell>
      <TableCell className="hidden md:table-cell px-4 py-3 whitespace-nowrap">
        <Badge className={`${getTypeClass(download.downloadType)} text-xs`}>
          {download.downloadType === "torrent" ? "torrent" : download.downloadType === "hls" ? "hls" : "http"}
        </Badge>
      </TableCell>
      <TableCell className="hidden md:table-cell px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
        {download.fileSize ? formatFileSize(download.fileSize) : "-"}
      </TableCell>
      <TableCell className="hidden md:table-cell px-4 py-3 text-sm text-muted-foreground capitalize whitespace-nowrap">
        <LocationLabel location={download.location} />
      </TableCell>
      <TableCell className="hidden md:table-cell px-4 py-3">
        {isDownloading && !!progress ? (
          <div className="w-full bg-gray-200 rounded h-3 min-w-[80px]">
            <motion.div
              className="bg-green-600 h-3 rounded"
              initial={{ width: 0 }}
              animate={{ width: `${progress?.percent ?? 0}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
        ) : (
          <Badge className={getStatusClass(download.status)}>
            {download.status}
          </Badge>
        )}
      </TableCell>
      <TableCell className="hidden md:table-cell px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
        {formatDate(download.createdAt)}
      </TableCell>
      <TableCell className="hidden md:table-cell px-4 py-3">
        {actionsMenu && (
          <div className="flex items-center justify-end">{actionsMenu}</div>
        )}
      </TableCell>
    </motion.tr>
  );
}
