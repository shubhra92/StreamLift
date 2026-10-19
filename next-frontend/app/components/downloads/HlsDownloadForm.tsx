"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@/components/ui/button";
import { getWorkerFileInfo } from "@/app/lib/workerConnection";
import type { FileInfo } from "./types";

type Step = "url" | "details";

type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; info: FileInfo };

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isHlsUrl(value: string): boolean {
  const v = value.toLowerCase();
  return v.endsWith(".m3u8") || v.includes("/playlist.m3u8") || v.includes(".m3u8?");
}

function normalizeHlsFilename(fileName: string): string {
  if (!fileName) return "video.mp4";
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "m3u8") return fileName.slice(0, -5) + ".mp4";
  if (ext && ext !== "mp4") return fileName + ".mp4";
  if (!ext) return fileName + ".mp4";
  return fileName;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export interface HlsDownloadFormProps {
  onSubmit: (
    sourceUrl: string,
    location: string,
    fileName?: string,
    fileSize?: number | null,
    fileType?: string | null
  ) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
  workers?: { id: string; name: string; online: boolean }[];
}

export function HlsDownloadForm({
  onSubmit,
  onCancel,
  loading,
  workers = [],
}: HlsDownloadFormProps) {
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>({ status: "idle" });
  const [fileName, setFileName] = useState("");
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);

  const urlInputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const onlineWorkers = workers.filter((w) => w.online);

  useEffect(() => {
    if (step === "url") {
      setTimeout(() => urlInputRef.current?.focus(), 50);
    }
  }, [step]);

  const reset = () => {
    abortRef.current?.abort();
    setStep("url");
    setUrl("");
    setUrlError(null);
    setFetchState({ status: "idle" });
    setFileName("");
    setSelectedWorkerId(null);
  };

  const handleNext = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setUrlError("Please enter a playlist URL (.m3u8).");
      return;
    }
    if (!isValidHttpUrl(trimmed)) {
      setUrlError("Enter a valid http/https URL.");
      return;
    }
    if (!isHlsUrl(trimmed)) {
      setUrlError("This doesn't look like an HLS playlist (.m3u8).");
      return;
    }

    if (onlineWorkers.length === 0) {
      setUrlError("HLS downloads require an online worker. No online workers found.");
      return;
    }

    const workerId = selectedWorkerId ?? onlineWorkers[0].id;
    setSelectedWorkerId(workerId);

    setUrlError(null);
    setFetchState({ status: "loading" });

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let info: FileInfo;
    try {
      info = await getWorkerFileInfo(workerId, trimmed, ctrl.signal);
    } catch (err: any) {
      if (err.name === "AbortError") return;
      setFetchState({
        status: "error",
        message: err?.message ?? "Network error fetching file info from worker.",
      });
      return;
    }

    const isHls = (info as any).isHls || info.fileType?.toLowerCase().includes("mpegurl") || isHlsUrl(trimmed) || isHlsUrl(info.fileName);
    if (!isHls) {
      setFetchState({
        status: "error",
        message: "The worker says this isn't an HLS stream. Use the HTTP tab for direct files.",
      });
      return;
    }

    const defaultName = normalizeHlsFilename(info.fileName || "video.mp4");
    setFileName(defaultName);
    setFetchState({ status: "done", info });
    setStep("details");
  };

  const handleCreate = async () => {
    const fetchedInfo = fetchState.status === "done" ? fetchState.info : null;
    if (!fetchedInfo) return;
    const workerId = selectedWorkerId ?? onlineWorkers[0].id;
    if (!workerId) {
      setUrlError("No online worker selected.");
      return;
    }
    const location = `worker-${workerId}`;
    await onSubmit(
      url.trim(),
      location,
      fileName.trim() || fetchedInfo.fileName,
      fetchedInfo.fileSize,
      fetchedInfo.fileType
    );
    reset();
  };

  const handleCancel = () => {
    reset();
    onCancel();
  };

  const handleUrlKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleNext();
    }
  };

  const isFetching = fetchState.status === "loading";
  const fetchedInfo = fetchState.status === "done" ? fetchState.info : null;

  return (
    <AnimatePresence mode="wait">
      {step === "url" && (
        <motion.div
          key="step-url"
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -16 }}
          transition={{ duration: 0.18 }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">HLS playlist URL (.m3u8)</label>
            <textarea
              ref={urlInputRef}
              placeholder="Paste .m3u8 playlist URL"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setUrlError(null);
                setFetchState({ status: "idle" });
              }}
              onKeyDown={handleUrlKeyDown}
              disabled={isFetching}
              rows={4}
              className="w-full p-3 border rounded-md mt-[10px] bg-background text-foreground resize-none font-mono text-sm disabled:opacity-50"
            />
            {urlError && <p className="text-sm text-destructive">{urlError}</p>}
            {fetchState.status === "error" && (
              <p className="text-sm text-destructive">{fetchState.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">Worker</label>
            <select
              value={selectedWorkerId ?? (onlineWorkers[0]?.id ?? "")}
              onChange={(e) => setSelectedWorkerId(e.target.value)}
              disabled={isFetching || onlineWorkers.length === 0}
              className="w-full p-2 border rounded-md bg-background text-foreground"
            >
              {onlineWorkers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              HLS streams are remuxed on the worker. Cloud/Server are not supported.
            </p>
          </div>

          <div className="flex flex-col-reverse sm:flex-row gap-3">
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={isFetching || loading}
              className="flex-1 cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              onClick={handleNext}
              disabled={isFetching || loading || !url.trim() || onlineWorkers.length === 0}
              className="flex-1 bg-blue-600 hover:bg-blue-700 cursor-pointer"
            >
              {isFetching ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Fetching…
                </span>
              ) : "Next →"}
            </Button>
          </div>
        </motion.div>
      )}

      {step === "details" && (
        <motion.div
          key="step-details"
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 16 }}
          transition={{ duration: 0.18 }}
          className="space-y-4"
        >
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Output file name (will be saved as MP4)</label>
            <input
              type="text"
              placeholder="video.mp4"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
          </div>

          <div className="flex gap-4 rounded-md border bg-muted/40 px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground mb-0.5">Type</p>
              <p className="text-sm font-medium truncate">HLS stream</p>
            </div>
            <div className="w-px bg-border" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground mb-0.5">Size</p>
              <p className="text-sm font-medium">
                {fetchedInfo && fetchedInfo.fileSize != null ? formatBytes(fetchedInfo.fileSize) : "Unknown"}
              </p>
            </div>
            <div className="w-px bg-border" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground mb-0.5">Quality</p>
              <p className="text-sm font-medium">Auto (best)</p>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Download location</label>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-4 py-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
              <span className="text-sm font-medium">
                {onlineWorkers.find((w) => w.id === (selectedWorkerId ?? onlineWorkers[0].id))?.name ?? "Worker"}
              </span>
            </div>
          </div>

          <div className="flex flex-col-reverse sm:flex-row gap-3">
            <Button
              variant="outline"
              onClick={() => setStep("url")}
              disabled={loading}
              className="flex-1 cursor-pointer"
            >
              ← Back
            </Button>
            <Button
              onClick={handleCreate}
              disabled={loading || !fileName.trim()}
              className="flex-1 bg-blue-600 hover:bg-blue-700 cursor-pointer"
            >
              {loading ? "Creating…" : "Create"}
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
