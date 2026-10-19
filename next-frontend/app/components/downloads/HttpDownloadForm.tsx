"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@/components/ui/button";
import { LocationSelect, locationName, locationDotClass } from "./LocationSelect";
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

const DEFAULT_LOCATION =
  process.env.NEXT_PUBLIC_SERVER_DOWNLOAD_ENABLED === "true" ? "server" : "cloud";

export interface HttpDownloadFormProps {
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

export function HttpDownloadForm({
  onSubmit,
  onCancel,
  loading,
  workers = [],
}: HttpDownloadFormProps) {
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>({ status: "idle" });
  const [fileName, setFileName] = useState("");
  const [location, setLocation] = useState(DEFAULT_LOCATION);
  const urlInputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

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
    setLocation(DEFAULT_LOCATION);
  };

  const workerId = location.startsWith("worker-") ? location.slice("worker-".length) : null;
  const worker = workerId ? workers.find((w) => w.id === workerId) : undefined;

  const handleNext = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setUrlError("Please enter a URL.");
      return;
    }
    if (!isValidHttpUrl(trimmed)) {
      setUrlError("Enter a valid http/https URL.");
      return;
    }
    setUrlError(null);
    setFetchState({ status: "loading" });

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let info: FileInfo;
    try {
      if (workerId && worker?.online) {
        info = await getWorkerFileInfo(workerId, trimmed, ctrl.signal);
      } else {
        const res = await fetch(
          `/api/file-info?url=${encodeURIComponent(trimmed)}`,
          { signal: ctrl.signal }
        );

        if (res.status === 401) {
          setFetchState({ status: "error", message: "Unauthorized. Please refresh and try again." });
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setFetchState({
            status: "error",
            message: body.error ?? `Could not fetch file info (${res.status}).`,
          });
          return;
        }
        info = await res.json();
      }

      setFileName(info.fileName);
      setFetchState({ status: "done", info });
      setStep("details");
    } catch (err: any) {
      if (err.name === "AbortError") return;
      setFetchState({
        status: "error",
        message: err?.message ?? "Network error fetching file info.",
      });
    }
  };

  const handleCreate = async () => {
    const fetchedInfo = fetchState.status === "done" ? fetchState.info : null;
    if (!fetchedInfo) return;
    await onSubmit(url.trim(), location, fileName.trim() || fetchedInfo.fileName, fetchedInfo.fileSize, fetchedInfo.fileType);
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
            <label className="text-sm text-muted-foreground">File URL</label>
            <textarea
              ref={urlInputRef}
              placeholder="Paste downloadable file URL"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setUrlError(null); setFetchState({ status: "idle" }); }}
              onKeyDown={handleUrlKeyDown}
              disabled={isFetching}
              rows={4}
              className="w-full p-3 border rounded-md mt-[10px] bg-background text-foreground resize-none font-mono text-sm disabled:opacity-50"
            />
            {urlError && (
              <p className="text-sm text-destructive">{urlError}</p>
            )}
            {fetchState.status === "error" && (
              <p className="text-sm text-destructive">{fetchState.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm text-muted-foreground">Download location</label>
            <LocationSelect value={location} onChange={setLocation} workers={workers} />
            {workerId && !worker?.online && (
              <p className="text-xs text-muted-foreground">
                Worker offline — fetching info via server instead.
              </p>
            )}
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
              disabled={isFetching || loading || !url.trim()}
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
            <label className="text-sm font-medium text-foreground">File name</label>
            <input
              type="text"
              placeholder="File name"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
          </div>

          {fetchedInfo && (
            <div className="flex gap-4 rounded-md border bg-muted/40 px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground mb-0.5">Type</p>
                <p className="text-sm font-medium truncate">
                  {fetchedInfo.fileType ?? "—"}
                </p>
              </div>
              <div className="w-px bg-border" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground mb-0.5">Size</p>
                <p className="text-sm font-medium">
                  {fetchedInfo.fileSize != null ? formatBytes(fetchedInfo.fileSize) : "Unknown"}
                </p>
              </div>
            </div>
          )}

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Download location</label>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-4 py-2.5">
              {locationDotClass(location, workers) && (
                <span className={`h-2.5 w-2.5 rounded-full ${locationDotClass(location, workers)}`} />
              )}
              <span className="text-sm font-medium">{locationName(location, workers)}</span>
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
