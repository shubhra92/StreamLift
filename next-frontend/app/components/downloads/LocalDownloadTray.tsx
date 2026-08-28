"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Download, Expand, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { WorkerFileTransfer, WorkerFileTransferPart } from "@/app/lib/sync-worker/workerProtocol";
import { MAX_SLOW_RESTARTS } from "@/app/lib/workerConnection";
import { formatFileSize } from "./utils";
import { DownloadingIcon } from "@/components/ui/custom-icons";

interface LocalDownloadTrayProps {
  transfers: Record<string, WorkerFileTransfer>;
  workerNames: Record<string, string>;
  onRestartPart?: (transferId: string, partIndex: number) => void;
  onRetryCloudPart?: (transferId: string, partIndex: number) => void;
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

function partPercent(part: WorkerFileTransferPart): number {
  const partLength = part.end - part.start + 1;
  return partLength > 0 ? Math.min(100, (part.receivedBytes / partLength) * 100) : 0;
}

/** One progress bar per part, side by side in a single line. */
function PartSegments({
  parts,
  expanded,
  transferId,
  onRestartPart,
  onRetryCloudPart,
}: {
  parts: WorkerFileTransferPart[];
  expanded: boolean;
  transferId: string;
  onRestartPart?: (transferId: string, partIndex: number) => void;
  onRetryCloudPart?: (transferId: string, partIndex: number) => void;
}) {
  const isCloud = transferId.startsWith("cloud:");
  const restartHandler = isCloud ? onRetryCloudPart : onRestartPart;

  // Optimistic spinner: flips the refresh button to a loading state immediately
  // on click, before the async reconnect round-trip sets part.reconnecting. Not
  // subject to the page's progress throttle. Cleared once the native reconnecting
  // flag takes over, the part completes, or a safety timeout elapses.
  const [clickedAt, setClickedAt] = useState<Partial<Record<number, number>>>({});
  useEffect(() => {
    if (Object.keys(clickedAt).length === 0) return;
    let changed = false;
    const next = { ...clickedAt };
    for (const part of parts) {
      if (next[part.index] !== undefined && (part.reconnecting === true || part.status === "completed" || Date.now() - next[part.index]! > 10_000)) {
        delete next[part.index];
        changed = true;
      }
    }
    if (changed) setClickedAt(next);
  }, [parts, clickedAt]);

  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        {parts.map((part) => {
          const pct = partPercent(part);
          const fillClass =
            part.status === "completed" ? "bg-green-500" :
            part.status === "failed" ? "bg-red-500" :
            part.status === "downloading" ? "bg-blue-500" :
            "bg-muted-foreground/20";
          return (
            <div
              key={part.index}
              className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
              title={`Part ${part.index + 1}: ${part.status} (${pct.toFixed(0)}%)`}
            >
              <motion.div
                className={`h-full rounded-full ${fillClass}`}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.25 }}
              />
            </div>
          );
        })}
      </div>
      {expanded && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          {parts.map((part) => {
            return (
            <span key={part.index} className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
              P{part.index + 1} {partPercent(part).toFixed(0)}%
              {part.status === "downloading" && (
                <span className="tabular-nums text-emerald-600" title="Current throughput for this part">
                  {speed(part.speedBytesPerSecond ?? null)}
                </span>
              )}
              {(part.status === "downloading" || part.status === "pending" || part.status === "failed") && restartHandler && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={`h-4 w-4 ${!part.reconnecting && "cursor-pointer"}`}
                  disabled={!!part.reconnecting || !!clickedAt[part.index]}
                  onClick={() => {
                    setClickedAt((prev) => ({ ...prev, [part.index]: Date.now() }));
                    restartHandler(transferId, part.index);
                  }}
                  title={part.reconnecting
                    ? "Connecting — wait until the connection finishes"
                    : "Refresh this part's connection (resumes from current offset)"}
                  aria-label={`Refresh part ${part.index + 1}`}
                >
                  {part.reconnecting || !!clickedAt[part.index] ? (
                    <RefreshCw className="h-3 w-3 animate-spin text-blue-600" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                </Button>
              )}
              {part.status === "failed" && (
                <span className="rounded bg-red-500/10 px-1 text-[9px] font-semibold text-red-600" title={part.error ?? "This part failed — refresh to retry"}>
                  failed
                </span>
              )}
              {(part.restartCount ?? 0) - (part.manualRestartCount ?? 0) > 0 && (
                <span className="rounded bg-blue-500/10 px-1 text-[9px] font-semibold text-blue-600" title="Auto reconnects (slow/stall, breaks, failures) toward the part's auto limit; manual refresh extends the limit">
                  ↻{(part.restartCount ?? 0) - (part.manualRestartCount ?? 0)} / {part.autoRestartLimit ?? MAX_SLOW_RESTARTS}
                </span>
              )}
              {!!part.manualRestartCount && (
                <span className="rounded bg-amber-500/10 px-1 text-[9px] font-semibold text-amber-600" title={`Manually refreshed ${part.manualRestartCount} times`}>
                  ↻{part.manualRestartCount}M
                </span>
              )}
              {!!part.phase2 && (
                <span className="rounded bg-purple-500/10 px-1 text-[9px] font-semibold text-purple-600" title="Phase 2: auto-retried after other parts completed">
                  P2
                </span>
              )}
            </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TransferRow({ transfer, workerNames, expanded = false, onRestartPart, onRetryCloudPart }: { transfer: WorkerFileTransfer; workerNames: Record<string, string>; expanded?: boolean; onRestartPart?: (transferId: string, partIndex: number) => void; onRetryCloudPart?: (transferId: string, partIndex: number) => void }) {
  const progress = percent(transfer);
  const parallel = transfer.parts && transfer.parts.length > 1 ? transfer.parts : null;
  const activePartCount = parallel ? parallel.filter((p) => p.status === "downloading").length : 0;
  const checking = transfer.status === "preparing";
  const quotaExceeded = transfer.error === "Transfer quota exceeded"
    || (transfer.parts?.some((p) => p.status === "failed" && p.error === "Transfer quota exceeded") ?? false);
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      {quotaExceeded && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-600">
          Transfer quota exceeded
        </div>
      )}
      <div className={quotaExceeded ? "space-y-2 opacity-60 pointer-events-none select-none" : "space-y-2"}>
        <div className="flex items-start justify-between gap-3">
          <p className={`min-w-0 flex-1 text-sm font-medium ${expanded ? "break-all leading-5" : "truncate"}`} title={transfer.fileName}>{transfer.fileName}</p>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{checking ? "Checking…" : progress === null ? "Preparing" : `${progress.toFixed(1)}%`}</span>
        </div>
        {checking ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <DownloadingIcon className="h-3.5 w-3.5 animate-pulse text-muted-foreground" />
            Checking file availability…
          </div>
        ) : parallel ? (
          <PartSegments parts={parallel} expanded={expanded} transferId={transfer.id} onRestartPart={onRestartPart} onRetryCloudPart={onRetryCloudPart} />
        ) : (
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <motion.div
              className={`h-full rounded-full ${progress !== null && progress >= 99.9 ? "bg-green-500" : "bg-blue-500"}`}
              animate={{ width: `${progress ?? 0}%` }}
              transition={{ duration: 0.25 }}
            />
          </div>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{formatFileSize(transfer.receivedBytes)} / {transfer.totalBytes ? formatFileSize(transfer.totalBytes) : "unknown"}</span>
          <span>{speed(transfer.speedBytesPerSecond)}</span>
          {parallel && (
            <span className="text-blue-600">{parallel.length} parts · {activePartCount} downloading in parallel</span>
          )}
          {expanded && <span>From: {transfer.workerId === "cloud" ? "Cloud" : `Worker: ${workerNames[transfer.workerId] ?? "Colab"}`}</span>}
        </div>
        {expanded && <p className="text-xs text-muted-foreground">Saving to the location you selected on this device.</p>}
      </div>
    </div>
  );
}

export function LocalDownloadTray({ transfers, workerNames, onRestartPart, onRetryCloudPart }: LocalDownloadTrayProps) {
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

  // Failed cloud items auto-dismiss 30s after failing (so a stranded quota/error
  // item doesn't stay forever and the tray closes once empty). Re-evaluate each second.
  const hasAgeableFailure = Object.values(transfers).some(
    (t) => t.workerId === "cloud" && t.status === "failed" && !t.cancelled,
  );
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasAgeableFailure) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasAgeableFailure]);

  const active = Object.values(transfers).filter((item) => {
    if (item.cancelled) return false;
    if (item.status === "preparing" || item.status === "downloading") return true;
    if (item.status === "failed" && item.workerId === "cloud") {
      return Date.now() - (item.updatedAt ?? 0) < 30000;
    }
    return false;
  });
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
            <div className="space-y-2">{active.slice(0, 2).map((item) => <TransferRow key={item.id} transfer={item} workerNames={workerNames} onRetryCloudPart={onRetryCloudPart} />)}</div>
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
          <DialogHeader>
            <DialogTitle>Local downloads</DialogTitle>
            <DialogDescription> </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">{active.map((item) => <TransferRow key={item.id} transfer={item} workerNames={workerNames} expanded onRestartPart={onRestartPart} onRetryCloudPart={onRetryCloudPart} />)}</div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
