"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clapperboard,
  Loader2,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatFileSize } from "@/app/components/downloads/utils";
import {
  cancelWorkerRender,
  deleteWorkerRender,
  getWorkerRenders,
  startWorkerRenders,
  type WorkerRenderQuality,
  type WorkerRenderState,
} from "@/app/lib/workerConnection";
import type { WatchFile } from "./types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workerId: string | null;
  workerName?: string;
  file: WatchFile | null;
}

const POLL_MS = 1500;

function formatEta(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  if (total < 60) return `${total}s left`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return `${minutes}m ${rest}s left`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m left`;
}

function stateLabel(quality: WorkerRenderQuality): string {
  if (quality.rendered) return "Ready";
  const job = quality.job;
  if (!job) return "Not rendered";
  switch (job.state) {
    case "queued":
      return "Queued";
    case "rendering":
      return "Rendering";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    default:
      return "Ready";
  }
}

function QualityRow({
  quality,
  selected,
  onToggle,
  onCancel,
  onDelete,
  busy,
}: {
  quality: WorkerRenderQuality;
  selected: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const job = quality.job;
  const rendering = job?.state === "rendering" || job?.state === "queued";
  const progress = Math.round((job?.progress ?? 0) * 100);
  const eta = formatEta(job?.etaSeconds ?? null);
  const failed = job?.state === "failed";
  const resettable = job?.state === "failed" || job?.state === "canceled";

  return (
    <div
      className={`rounded-lg border p-3 transition ${
        selected ? "border-blue-500/70 bg-blue-500/5" : "border-border bg-card"
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          disabled={quality.rendered || rendering || busy}
          onChange={onToggle}
          className="mt-1 h-4 w-4 shrink-0 accent-blue-600"
          aria-label={`Pre-render ${quality.label}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{quality.label}</span>
            {quality.copy && (
              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                fast remux
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {quality.rendered && job?.bytes
                ? formatFileSize(job.bytes)
                : quality.estimatedBytes
                  ? `~${formatFileSize(quality.estimatedBytes)}`
                  : ""}
            </span>
          </div>

          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            {quality.rendered ? (
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" /> {stateLabel(quality)}
              </span>
            ) : rendering ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {stateLabel(quality)} · {progress}%{eta ? ` · ${eta}` : ""}
              </span>
            ) : failed ? (
              <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                <AlertCircle className="h-3.5 w-3.5" />
                {job?.detail ?? "Pre-render failed"}
              </span>
            ) : (
              <span>
                {resettable
                  ? "Select this quality to retry"
                  : job?.state === "canceled"
                    ? "Canceled"
                    : "Not rendered"}
              </span>
            )}
          </div>

          {rendering && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-blue-600 transition-all"
                style={{ width: `${Math.max(2, progress)}%` }}
              />
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {rendering ? (
            <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
              <XCircle className="h-4 w-4" /> Cancel
            </Button>
          ) : quality.rendered ? (
            <Button size="sm" variant="outline" onClick={onDelete} disabled={busy}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Per-item pre-render dialog: choose one or more qualities, render them in the
 * background on the worker, then serve them as static HLS. Playback of a
 * rendered quality costs no worker CPU and cannot stall on encoder lag.
 */
export function RenderDialog({
  open,
  onOpenChange,
  workerId,
  workerName,
  file,
}: Props) {
  const [state, setState] = useState<WorkerRenderState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const timerRef = useRef<number | null>(null);

  const fileKey = file ? `${file.downloadId}:${file.index}` : "";

  const load = useCallback(async () => {
    if (!workerId || !file) return;
    try {
      const next = await getWorkerRenders(workerId, file.downloadId, file.index);
      setState(next);
      setError(null);
      setSelected((current) => {
        if (current.size === 0) return current;
        const available = new Set(
          next.qualities
            .filter((quality) => !quality.rendered && !quality.job)
            .map((quality) => quality.id),
        );
        const kept = new Set([...current].filter((id) => available.has(id)));
        return kept.size === current.size ? current : kept;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read pre-render status");
    }
  }, [workerId, file]);

  useEffect(() => {
    if (!open || !fileKey) {
      setState(null);
      setSelected(new Set());
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);

    const tick = async () => {
      if (cancelled) return;
      await load();
      if (cancelled) return;
      setLoading(false);
      timerRef.current = window.setTimeout(tick, POLL_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [open, fileKey, load]);

  const qualities = state?.qualities ?? [];
  const selectable = useMemo(
    () =>
      qualities.filter(
        (quality) =>
          !quality.rendered &&
          (!quality.job ||
            quality.job.state === "failed" ||
            quality.job.state === "canceled"),
      ),
    [qualities],
  );

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = async (action: () => Promise<WorkerRenderState>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setState(next);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The worker rejected the request");
    } finally {
      setBusy(false);
    }
  };

  const handleStart = () => {
    if (!workerId || !file || selected.size === 0) return;
    void run(async () => {
      const next = await startWorkerRenders(
        workerId,
        file.downloadId,
        file.index,
        [...selected],
      );
      setSelected(new Set());
      return next;
    });
  };

  const handleCancel = (quality: string) => {
    if (!workerId || !file) return;
    void run(() => cancelWorkerRender(workerId, file.downloadId, file.index, quality));
  };

  const handleDelete = (quality: WorkerRenderQuality) => {
    if (!workerId || !file) return;
    const ok = window.confirm(
      `Delete the ${quality.label} pre-render? Playback will fall back to on-demand transcoding for this quality.`,
    );
    if (!ok) return;
    void run(() => deleteWorkerRender(workerId, file.downloadId, file.index, quality.id));
  };

  const renderedCount = qualities.filter((quality) => quality.rendered).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 text-left">
            <Clapperboard className="h-5 w-5 shrink-0 text-blue-600" />
            Pre-render for smooth playback
          </DialogTitle>
          <DialogDescription className="text-left">
            Render the whole file once on {workerName || "this worker"}. Playing a
            pre-rendered quality uses no transcoder CPU and cannot stall waiting for
            the encoder.
          </DialogDescription>
        </DialogHeader>

        {file && (
          <div className="min-w-0 rounded-lg border bg-muted/40 px-3 py-2">
            <p className="truncate text-sm font-medium" title={file.name}>
              {file.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatFileSize(file.size)}
              {renderedCount > 0 ? ` · ${renderedCount} quality ready` : ""}
              {state?.renderedBytes ? ` · ${formatFileSize(state.renderedBytes)} on disk` : ""}
            </p>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading && !state ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading render options…
          </div>
        ) : qualities.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            This file cannot be pre-rendered (no video stream or unknown duration).
          </p>
        ) : (
          <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
            {qualities.map((quality) => (
              <QualityRow
                key={quality.id}
                quality={quality}
                selected={selected.has(quality.id)}
                onToggle={() => toggle(quality.id)}
                onCancel={() => handleCancel(quality.id)}
                onDelete={() => handleDelete(quality)}
                busy={busy}
              />
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Renders stay on the worker until you delete them or the worker session
            ends. Rendering uses the worker CPU in the background.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              onClick={handleStart}
              disabled={busy || selected.size === 0 || selectable.length === 0}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Clapperboard className="h-4 w-4" />
              )}
              {selected.size > 0
                ? `Render ${selected.size} quality${selected.size === 1 ? "" : "s"}`
                : "Render"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
