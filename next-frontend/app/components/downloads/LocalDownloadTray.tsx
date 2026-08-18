"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Download, Expand, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { WorkerFileTransfer } from "@/app/lib/sync-worker/workerProtocol";
import { formatFileSize } from "./utils";
import { DownloadingIcon } from "@/components/ui/custom-icons";

interface LocalDownloadTrayProps {
  transfers: Record<string, WorkerFileTransfer>;
  workerNames: Record<string, string>;
}

type TrayCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

const CORNER_CLASS: Record<TrayCorner, string> = {
  "top-left": "left-5 top-5",
  "top-right": "right-5 top-5",
  "bottom-left": "bottom-5 left-5",
  "bottom-right": "bottom-5 right-5",
};

function percent(transfer: WorkerFileTransfer): number | null {
  return transfer.totalBytes ? Math.min(100, (transfer.receivedBytes / transfer.totalBytes) * 100) : null;
}

function speed(value: number | null): string {
  return value && value > 0 ? `${formatFileSize(value)}/s` : "Calculating speed…";
}

function TransferRow({ transfer, workerNames, expanded = false }: { transfer: WorkerFileTransfer; workerNames: Record<string, string>; expanded?: boolean }) {
  const progress = percent(transfer);
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <p className={`min-w-0 flex-1 text-sm font-medium ${expanded ? "break-all leading-5" : "truncate"}`} title={transfer.fileName}>{transfer.fileName}</p>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{progress === null ? "Preparing" : `${progress.toFixed(1)}%`}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <motion.div className="h-full rounded-full bg-primary" animate={{ width: `${progress ?? 0}%` }} transition={{ duration: 0.25 }} />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{formatFileSize(transfer.receivedBytes)} / {transfer.totalBytes ? formatFileSize(transfer.totalBytes) : "unknown"}</span>
        <span>{speed(transfer.speedBytesPerSecond)}</span>
        {expanded && <span>From worker: {workerNames[transfer.workerId] ?? "Colab"}</span>}
      </div>
      {expanded && <p className="text-xs text-muted-foreground">Saving to the location you selected on this device.</p>}
    </div>
  );
}

export function LocalDownloadTray({ transfers, workerNames }: LocalDownloadTrayProps) {
  const [miniOpen, setMiniOpen] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);
  const [corner, setCorner] = useState<TrayCorner>("bottom-right");
  const dragged = useRef(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("streamlift-local-download-tray-corner");
    if (saved === "top-left" || saved === "top-right" || saved === "bottom-left" || saved === "bottom-right") {
      setCorner(saved);
    }
  }, []);

  const active = Object.values(transfers).filter((item) => item.status === "preparing" || item.status === "downloading");
  if (active.length === 0) return null;

  const opensUpward = corner.startsWith("bottom");
  const opensLeft = corner.endsWith("right");

  return (
    <motion.div key={corner} drag dragMomentum={false} onDragStart={() => { dragged.current = true; }}
      onDragEnd={(_, info) => {
        // Equal distances deliberately prefer the right and bottom corners.
        const horizontal = info.point.x >= window.innerWidth / 2 ? "right" : "left";
        const vertical = info.point.y >= window.innerHeight / 2 ? "bottom" : "top";
        const next = `${vertical}-${horizontal}` as TrayCorner;
        setCorner(next);
        window.localStorage.setItem("streamlift-local-download-tray-corner", next);
        window.setTimeout(() => { dragged.current = false; }, 0);
      }}
      className={`fixed z-[60] touch-none ${CORNER_CLASS[corner]}`}>
      <AnimatePresence>
        {miniOpen && (
          <motion.div initial={{ opacity: 0, scale: 0.92, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.92, y: 12 }}
            className={`absolute w-80 rounded-xl border bg-card p-3 shadow-xl ${opensUpward ? "bottom-16" : "top-16"} ${opensLeft ? "right-0" : "left-0"}`}>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold">Downloading to your device</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setMiniOpen(false)}><X className="h-4 w-4" /></Button>
            </div>
            <div className="space-y-2">{active.slice(0, 2).map((item) => <TransferRow key={item.id} transfer={item} workerNames={workerNames} />)}</div>
            <Button variant="outline" className="mt-3 w-full" onClick={() => { setMiniOpen(false); setFullOpen(true); }}>
              <Expand className="mr-2 h-4 w-4" /> View all downloads
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <Button size="icon" className="relative h-10 w-10 rounded-full shadow-lg" aria-label="Show local download progress" onClick={() => {
        if (!dragged.current) setMiniOpen((open) => !open);
      }}>
        <DownloadingIcon color="#ffffff" />
        <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">{active.length}</span>
      </Button>

      <Dialog open={fullOpen} onOpenChange={setFullOpen}>
        <DialogContent className="max-h-[80vh] w-[calc(100vw-2rem)] overflow-x-hidden overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>Local downloads</DialogTitle></DialogHeader>
          <div className="space-y-3">{active.map((item) => <TransferRow key={item.id} transfer={item} workerNames={workerNames} expanded />)}</div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
