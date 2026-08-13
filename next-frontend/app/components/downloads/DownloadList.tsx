"use client";

import { AnimatePresence } from "motion/react";
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
  deletingId,
  progress,
  onSelect,
  onDelete,
  onEdit,
}: DownloadListProps) {
  return (
    <div className="bg-card rounded-xl shadow-md border overflow-hidden">
      {/* table-fixed: columns respect explicit widths; w-full: fills container */}
      <Table className="w-full table-fixed">
        <TableHeader className="hidden md:table-header-group">
          <TableRow className="bg-muted/50">
            {/* File name gets all remaining space */}
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 min-w-0">File Name</TableHead>
            {/* Fixed-width columns that never grow */}
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-32">File Size</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-36">Location</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-36">Status</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-40">Created</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-24"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <AnimatePresence mode="popLayout">
            {downloads.length === 0 ? (
              <TableRow>
                <TableCell className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No downloads yet. Click "Add Download" to create one.
                </TableCell>
              </TableRow>
            ) : (
              downloads.map((download) => (
                <DownloadItem
                  key={download.id}
                  download={download}
                  isDownloading={downloadingFileId === download.id}
                  isDeleting={deletingId === download.id}
                  progress={downloadingFileId === download.id ? progress : null}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onEdit={onEdit}
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
