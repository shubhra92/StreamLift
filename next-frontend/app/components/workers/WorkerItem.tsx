"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Copy, Trash2, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { formatDate } from "./utils";
import type { WorkerItemProps } from "./types";

const computeLabel: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const locationLabel: Record<string, string> = {
  local: "Local",
  mega: "Mega",
};

export function WorkerItem({ worker, isSelected, isDeleting, onSelect, onDelete, onCopyScript }: WorkerItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      onDelete();
      setConfirmDelete(false);
    } else {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
    }
  };

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    onCopyScript();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.tr
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      onClick={onSelect}
      className={`hover:bg-muted/50 cursor-pointer border-b transition-colors ${
        isSelected ? "bg-blue-50/50 dark:bg-blue-950/20" : ""
      }`}
    >
      {/* ── Mobile card view ─────────────────────────────────────────────── */}
      <TableCell className="p-3 md:hidden" colSpan={7}>
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                  worker.online ? "bg-green-500" : "bg-gray-400"
                }`}
              />
              <p className="font-medium text-sm truncate">{worker.name}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 cursor-pointer"
                title="Copy worker script"
                disabled={isDeleting}
                onClick={handleCopy}
              >
                <AnimatePresence mode="wait" initial={false}>
                  {copied ? (
                    <motion.span key="check" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ duration: 0.15 }}>
                      <Check className="h-4 w-4 text-green-500" />
                    </motion.span>
                  ) : (
                    <motion.span key="copy" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ duration: 0.15 }}>
                      <Copy className="h-4 w-4 text-muted-foreground" />
                    </motion.span>
                  )}
                </AnimatePresence>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 cursor-pointer ${
                  confirmDelete ? "text-destructive hover:text-destructive" : ""
                }`}
                title={confirmDelete ? "Click again to confirm" : "Delete worker"}
                disabled={isDeleting}
                onClick={handleDelete}
              >
                <AnimatePresence mode="wait" initial={false}>
                  {isDeleting ? (
                    <motion.span key="spin" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ duration: 0.15 }}>
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </motion.span>
                  ) : (
                    <motion.span key="trash" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ duration: 0.15 }}>
                      <Trash2 className="h-4 w-4" />
                    </motion.span>
                  )}
                </AnimatePresence>
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge
              className={
                worker.online
                  ? "bg-green-100 text-green-800 text-xs"
                  : "bg-gray-100 text-gray-600 text-xs"
              }
            >
              {worker.online ? "Online" : "Offline"}
            </Badge>
            <Badge className="bg-blue-100 text-blue-800 text-xs">
              {computeLabel[worker.computeType] ?? worker.computeType}
            </Badge>
            <Badge className="bg-purple-100 text-purple-800 text-xs">
              {locationLabel[worker.downloadLocation] ?? worker.downloadLocation}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            IP: {worker.ipAddress ?? "Not connected"}
          </p>
          {confirmDelete && (
            <p className="text-xs text-destructive">Click delete again to confirm</p>
          )}
        </div>
      </TableCell>

      {/* ── Desktop table view ───────────────────────────────────────────── */}
      {/* Name */}
      <TableCell className="hidden md:table-cell px-4 py-3 text-sm min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
              worker.online ? "bg-green-500" : "bg-gray-400"
            }`}
          />
          <span className="block truncate font-medium" title={worker.name}>
            {worker.name}
          </span>
        </div>
      </TableCell>

      {/* Status */}
      <TableCell className="hidden md:table-cell px-4 py-3">
        <Badge
          className={
            worker.online
              ? "bg-green-100 text-green-800 text-xs"
              : "bg-gray-100 text-gray-600 text-xs"
          }
        >
          {worker.online ? "Online" : "Offline"}
        </Badge>
      </TableCell>

      {/* Compute */}
      <TableCell className="hidden md:table-cell px-4 py-3">
        <Badge className="bg-blue-100 text-blue-800 text-xs">
          {computeLabel[worker.computeType] ?? worker.computeType}
        </Badge>
      </TableCell>

      {/* Location */}
      <TableCell className="hidden md:table-cell px-4 py-3">
        <Badge className="bg-purple-100 text-purple-800 text-xs">
          {locationLabel[worker.downloadLocation] ?? worker.downloadLocation}
        </Badge>
      </TableCell>

      {/* IP Address */}
      <TableCell className="hidden md:table-cell px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
        {worker.ipAddress ?? "Not connected"}
      </TableCell>

      {/* Created */}
      <TableCell className="hidden md:table-cell px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
        {formatDate(worker.createdAt?.toString())}
      </TableCell>

      {/* Actions */}
      <TableCell className="hidden md:table-cell px-4 py-3">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 cursor-pointer"
            title="Copy worker script"
            disabled={isDeleting}
            onClick={handleCopy}
          >
            <AnimatePresence mode="wait" initial={false}>
              {copied ? (
                <motion.span key="check" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ duration: 0.15 }}>
                  <Check className="h-3.5 w-3.5 text-green-500" />
                </motion.span>
              ) : (
                <motion.span key="copy" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ duration: 0.15 }}>
                  <Copy className="h-3.5 w-3.5" />
                </motion.span>
              )}
            </AnimatePresence>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={`h-8 w-8 cursor-pointer ${
              confirmDelete ? "text-destructive hover:text-destructive" : ""
            }`}
            title={confirmDelete ? "Click again to confirm" : "Delete worker"}
            disabled={isDeleting}
            onClick={handleDelete}
          >
            <AnimatePresence mode="wait" initial={false}>
              {isDeleting ? (
                <motion.span key="spin" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ duration: 0.15 }}>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                </motion.span>
              ) : (
                <motion.span key="trash" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ duration: 0.15 }}>
                  <Trash2 className="h-3.5 w-3.5" />
                </motion.span>
              )}
            </AnimatePresence>
          </Button>
        </div>
        {confirmDelete && (
          <p className="text-xs text-destructive mt-1 whitespace-nowrap">Click again to confirm</p>
        )}
      </TableCell>
    </motion.tr>
  );
}
