"use client";

import { motion } from "motion/react";
import { Trash2, Pencil, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { formatDate, formatFileSize, getStatusClass, getStatusVariant } from "./utils";
import type { DownloadItemProps } from "./types";
import { LocationLabel } from "./LocationLabel";

export function DownloadItem({
  download,
  isDownloading,
  isDeleting,
  isSelected,
  progress,
  onSelect,
  onDelete,
  onEdit,
}: DownloadItemProps) {
  const canEdit = download.status === "pending";
  const canDelete = download.status !== "downloading" && !isDownloading;
  return (
    <motion.tr
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      className={`hover:bg-muted/50 cursor-pointer border-b transition-colors ${
        isSelected ? "bg-blue-50/50 dark:bg-blue-950/20" : ""
      }`}
      onClick={() => onSelect(download.id)}
    >
      {/* Mobile Card View */}
      <TableCell className="p-3 md:hidden" colSpan={6}>
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium text-sm truncate flex-1">
              {download.fileName || "-"}
            </p>
            <div className="flex items-center gap-1 shrink-0">
              {canEdit && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(download);
                  }}
                >
                  <Pencil className="h-4 w-4 text-muted-foreground" />
                </Button>
              )}
              {canDelete && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  disabled={isDeleting}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(download.id);
                  }}
                >
                  {isDeleting
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Trash2 className="h-4 w-4" />
                  }
                </Button>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{download.fileSize ? formatFileSize(download.fileSize) : "-"}</span>
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
              <Badge
                // variant={getStatusVariant(download.status)}
                className={getStatusClass(download.status)}
              >
                {download.status}
              </Badge>
          )}
        </div>
      </TableCell>

      {/* Desktop Table View */}
      {/* File name: min-w-0 lets the cell shrink; overflow+truncate clips long names */}
      <TableCell className="hidden md:table-cell px-4 py-3 text-sm min-w-0">
        <span className="block truncate" title={download.fileName || undefined}>
          {download.fileName || "-"}
        </span>
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
        {canDelete && (
          <div className="flex items-center gap-1">
            {canEdit && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(download);
                }}
              >
                <Pencil className="h-4 w-4 text-muted-foreground" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:text-destructive"
              disabled={isDeleting}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(download.id);
              }}
            >
              {isDeleting
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Trash2 className="h-4 w-4" />
              }
            </Button>
          </div>
        )}
      </TableCell>
    </motion.tr>
  );
}
