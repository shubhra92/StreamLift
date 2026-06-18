"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Copy, Trash2, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

export function WorkerItem({ worker, isSelected, onSelect, onDelete, onCopyScript }: WorkerItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

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
  };

  return (
    <motion.div
      whileHover={{ scale: 1.005 }}
      transition={{ duration: 0.15 }}
      onClick={onSelect}
      className={`bg-card border rounded-xl p-4 cursor-pointer transition-colors ${
        isSelected ? "border-blue-500 ring-1 ring-blue-500" : "hover:border-muted-foreground/40"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Left: info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {/* Online indicator */}
            <span
              className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                worker.online ? "bg-green-500" : "bg-gray-400"
              }`}
            />
            <p className="font-semibold truncate">{worker.name}</p>
          </div>

          <div className="flex flex-wrap gap-1.5 mb-2">
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

          <p className="text-xs text-muted-foreground truncate">
            IP: {worker.ipAddress ?? "Not connected"}
          </p>
          <p className="text-xs text-muted-foreground">
            Created {formatDate(worker.createdAt?.toString())}
          </p>
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 cursor-pointer"
            title="Copy worker script"
            onClick={handleCopy}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className={`h-8 w-8 cursor-pointer ${
              confirmDelete ? "text-destructive hover:text-destructive" : ""
            }`}
            title={confirmDelete ? "Click again to confirm" : "Delete worker"}
            onClick={handleDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>

          <ChevronRight
            className={`h-4 w-4 text-muted-foreground transition-transform ${
              isSelected ? "rotate-90" : ""
            }`}
          />
        </div>
      </div>

      {confirmDelete && (
        <p className="text-xs text-destructive mt-2">Click delete again to confirm</p>
      )}
    </motion.div>
  );
}
