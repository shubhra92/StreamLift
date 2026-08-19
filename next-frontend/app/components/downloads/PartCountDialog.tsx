"use client";

import { useEffect, useMemo, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { getMaxPartsForSize } from "@/app/lib/workerConnection";
import { formatFileSize } from "./utils";
import { motion } from "motion/react";

interface PartCountDialogProps {
  isOpen: boolean;
  fileSize: number;
  onClose: () => void;
  onConfirm: (parts: number) => void;
}

const DEFAULT_PARTS = 4;

export function PartCountDialog({ isOpen, fileSize, onClose, onConfirm }: PartCountDialogProps) {
  const maxParts = getMaxPartsForSize(fileSize);
  const [selected, setSelected] = useState(Math.min(DEFAULT_PARTS, maxParts));

  useEffect(() => {
    if (isOpen) setSelected(Math.min(DEFAULT_PARTS, maxParts));
  }, [isOpen, maxParts]);

  const decrease = () => setSelected((value) => Math.max(1, value - 1));
  const increase = () => setSelected((value) => Math.min(maxParts, value + 1));
  const partSize = fileSize > 0 ? Math.ceil(fileSize / selected) : 0;

  // Random fill level per segment, regenerated when the part count changes
  // so the bar looks like a real download in progress.
  const fills = useMemo(() => {
    if (!isOpen) return [];
    return Array.from({ length: selected }, () => Math.floor(Math.random() * 61) + 20);
  }, [isOpen, selected]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Download in parts</DialogTitle>
          <DialogDescription>
            Split the download into parallel connections for more speed.
            File size: {fileSize ? formatFileSize(fileSize) : "unknown"}
          </DialogDescription>
        </DialogHeader>

        {/* Big segmented preview bar — splits into `selected` parts */}
        <div className="flex w-full h-4 gap-2">
          {fills.map((fill, i) => (
            <div
              key={i}
              className="relative h-full flex-1 overflow-hidden rounded-full bg-gray-100"
            >
              <motion.div
                className="h-full rounded-full bg-blue-500"
                 initial={{ width: 0 }}
                animate={{ width: `${fill}%` }}
                transition={{ duration: 0.25}}
              />
            </div>
          ))}
        </div>

        {/* Stepper */}
        <div className="flex items-center justify-center gap-4">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-9 w-9 cursor-pointer"
            onClick={decrease}
            disabled={selected <= 1}
            aria-label="Fewer parts"
          >
            <Minus className="h-4 w-4" />
          </Button>
          <div className="w-20 rounded-lg border bg-muted/40 py-1.5 text-center text-lg font-semibold tabular-nums">
            {selected}
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-9 w-9 cursor-pointer"
            onClick={increase}
            disabled={selected >= maxParts}
            aria-label="More parts"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          {selected > 1
            ? `${selected} parts = ${selected} parallel connections (${formatFileSize(partSize)} each)`
            : "Single stream — slowest but uses one connection"}
        </p>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" className="cursor-pointer" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" className="bg-blue-500 text-white hover:bg-blue-600 cursor-pointer" onClick={() => onConfirm(selected)}>
            Start download
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}