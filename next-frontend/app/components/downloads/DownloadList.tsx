"use client";

import { AnimatePresence } from "motion/react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DownloadItem } from "./DownloadItem";
import type { DownloadListProps } from "./types";

export function DownloadList({
  downloads,
  downloadingFileId,
  deletingIds,
  selectedId,
  progress,
  onSelect,
  onDelete,
  onEdit,
  workerFilesByDownload,
  onDownloadWorkerFile,
  onDownloadWorkerFileExternalLink,
  workerFileTransfers,
  onCreateShareLink,
  onCloudExternalLink,
  onCloudTabDownload,
  creatingLinkIds,
  watchDownloadIds,
  onAddToWatch,
  addingWatchIds,
  onlineWorkerIds,
  selectionMode = false,
  checkedIds,
  onToggleChecked,
  onToggleAll,
  onClearChecked,
  onBulkDelete,
  isBulkDeleting = false,
}: DownloadListProps) {
  // A row can be batch-selected with the same rule that gates deletion.
  const selectableIds = downloads
    .filter((d) => d.status !== "downloading" && downloadingFileId !== d.id)
    .map((d) => d.id);
  const selectableIdSet = new Set(selectableIds);
  const checkedSelectableIds = selectableIds.filter((id) => checkedIds.has(id));
  const checkedCount = checkedSelectableIds.length;
  const allSelected = selectableIds.length > 0 && checkedCount === selectableIds.length;
  const headerChecked: boolean | "indeterminate" =
    allSelected ? true : checkedCount > 0 ? "indeterminate" : false;
  const columnCount = selectionMode ? 8 : 7;

  return (
    <div className="bg-card rounded-xl shadow-md border overflow-hidden">
      {selectionMode && (
        <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-4 py-2">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-sm font-medium whitespace-nowrap">
              {checkedCount} selected
            </span>
            {/* Mobile has no table header, so expose select-all here. */}
            <button
              type="button"
              className="text-xs font-medium text-blue-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50 md:hidden"
              disabled={selectableIds.length === 0 || isBulkDeleting}
              onClick={() => onToggleAll(selectableIds)}
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="cursor-pointer"
              disabled={checkedCount === 0 || isBulkDeleting}
              onClick={onClearChecked}
            >
              Clear
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="cursor-pointer whitespace-nowrap"
              disabled={checkedCount === 0 || isBulkDeleting}
              onClick={onBulkDelete}
            >
              {isBulkDeleting
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Trash2 className="h-4 w-4" />}
              <span className="hidden sm:inline">Delete selected</span>
              <span className="sm:hidden">Delete</span>
            </Button>
          </div>
        </div>
      )}

      {/* table-fixed: columns respect explicit widths; w-full: fills container */}
      <Table className="w-full table-fixed">
        <TableHeader className="hidden md:table-header-group">
          <TableRow className="bg-muted/50">
            {selectionMode && (
              <TableHead className="px-3 py-3 w-12">
                <Checkbox
                  checked={headerChecked}
                  disabled={selectableIds.length === 0 || isBulkDeleting}
                  onCheckedChange={() => onToggleAll(selectableIds)}
                  aria-label="Select all downloads"
                />
              </TableHead>
            )}
            {/* File name gets all remaining space */}
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 min-w-0">File Name</TableHead>
            {/* Fixed-width columns that never grow */}
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-28">Type</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-32">File Size</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-36">Location</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-36">Status</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-40">Created</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-16"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <AnimatePresence mode="popLayout">
            {downloads.length === 0 ? (
              <TableRow>
                <TableCell className="px-4 py-8 text-center text-muted-foreground" colSpan={columnCount}>
                  No downloads yet. Click "Add Download" to create one.
                </TableCell>
              </TableRow>
            ) : (
              downloads.map((download) => (
                <DownloadItem
                  key={download.id}
                  download={download}
                  isDownloading={downloadingFileId === download.id}
                  isDeleting={deletingIds.has(download.id)}
                  isSelected={selectedId === download.id}
                  progress={downloadingFileId === download.id ? progress : null}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onEdit={onEdit}
                  workerFiles={workerFilesByDownload[download.id]}
                  onDownloadWorkerFile={onDownloadWorkerFile}
                  onDownloadWorkerFileExternalLink={onDownloadWorkerFileExternalLink}
                  workerFileTransfer={Object.values(workerFileTransfers).find((transfer) => transfer.downloadId === download.id && !transfer.cancelled && (transfer.status === "preparing" || transfer.status === "downloading"))}
                  onCreateShareLink={onCreateShareLink}
                  onCloudExternalLink={onCloudExternalLink}
                  onCloudTabDownload={onCloudTabDownload}
                  isCreatingLink={creatingLinkIds?.has(download.id)}
                  watchDownloadIds={watchDownloadIds}
                  onAddToWatch={onAddToWatch}
                  isAddingToWatch={addingWatchIds?.has(download.id)}
                  onlineWorkerIds={onlineWorkerIds}
                  selectionMode={selectionMode}
                  isChecked={selectableIdSet.has(download.id) && checkedIds.has(download.id)}
                  onToggleChecked={onToggleChecked}
                />
              ))
            )}
          </AnimatePresence>
        </TableBody>
      </Table>
    </div>
  );
}

function TableCell({ children, className, colSpan }: { children: React.ReactNode; className?: string; colSpan?: number }) {
  return <td className={className} colSpan={colSpan}>{children}</td>;
}
