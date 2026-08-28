"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { LocationSelect } from "./LocationSelect";
import type { AddDownloadModalProps, FileInfo } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = "url" | "details";

type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; info: FileInfo };

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Component ────────────────────────────────────────────────────────────────

export function AddDownloadModal({
  isOpen,
  onClose,
  onSubmit,
  loading,
  workers = [],
}: AddDownloadModalProps) {
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>({ status: "idle" });
  const [fileName, setFileName] = useState("");
  const [location, setLocation] = useState(DEFAULT_LOCATION);
  const urlInputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Focus URL input when modal opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => urlInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const reset = () => {
    abortRef.current?.abort();
    setStep("url");
    setUrl("");
    setUrlError(null);
    setFetchState({ status: "idle" });
    setFileName("");
    setLocation(DEFAULT_LOCATION);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  // ── Step 1: fetch file info ───────────────────────────────────────────────

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

    try {
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

      const info: FileInfo = await res.json();
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

  // ── Step 2: create download ───────────────────────────────────────────────

  const handleCreate = async () => {
    if (!fetchedInfo) return;
    await onSubmit(url.trim(), location, fileName.trim() || fetchedInfo.fileName, fetchedInfo);
    reset();
  };

  const handleUrlKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleNext();
    }
  };

  const isFetching = fetchState.status === "loading";
  const fetchedInfo = fetchState.status === "done" ? fetchState.info : null;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Download</DialogTitle>
          <DialogDescription>
            Paste the URL of the file you want to download, then click Next.
          </DialogDescription>
        </DialogHeader>

        <AnimatePresence mode="wait">

          {/* ── Step 1: URL ── */}
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

              <div className="flex flex-col-reverse sm:flex-row gap-3">
                <Button
                  variant="outline"
                  onClick={handleClose}
                  disabled={isFetching}
                  className="flex-1 cursor-pointer"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleNext}
                  disabled={isFetching || !url.trim()}
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

          {/* ── Step 2: Details ── */}
          {step === "details" && fetchedInfo && (
            <motion.div
              key="step-details"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{ duration: 0.18 }}
              className="space-y-4"
            >
              {/* Editable file name — first */}
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

              {/* File info row — type + size as labeled fields */}
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

              {/* Location picker */}
              <LocationSelect value={location} onChange={setLocation} workers={workers} />

              <div className="flex flex-col-reverse sm:flex-row gap-3">
                <Button
                  variant="outline"
                  onClick={() => { setStep("url"); setFetchState({ status: "idle" }); }}
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
      </DialogContent>
    </Dialog>
  );
}
