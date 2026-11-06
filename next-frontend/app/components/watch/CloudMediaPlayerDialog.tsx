"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { downloadCloudFileToDisk } from "@/app/lib/workerConnection";
import { downloadCloudFileToBlob, type CloudBlobDownload } from "@/app/lib/cloudMedia";
import {
  cloudStreamUrl,
  ensureWatchStreamWorker,
  probeWatchStream,
  registerWatchStream,
  unregisterWatchStream,
} from "@/app/lib/cloudStream";
import type { WatchItemDto } from "@/app/lib/watchTypes";
import { MediaPlayer } from "./player/MediaPlayer";
import type { PlaybackSource, PlayerStatus } from "./player/types";
import type { WatchFile } from "./types";

interface Props {
  item: WatchItemDto | null;
  items?: WatchItemDto[];
  onChangeItem?: (item: WatchItemDto) => void;
  onClose: () => void;
}

type PlaybackMode = "stream" | "blob";

const BLOB_FALLBACK_WARN_BYTES = 2 * 1024 * 1024 * 1024;

function providerLabel(provider: string): string {
  return provider === "mega" ? "MEGA" : provider.toUpperCase();
}

/**
 * Plays a saved cloud Watch item with the same MediaPlayer chrome as worker
 * files.
 *
 * Primary path: the service worker range-decrypts MEGA bytes into a same-origin
 * HTTP 206 response, so seeking stays cheap and memory use is bounded. If the
 * browser cannot use that path, fall back to downloading the decrypted file as
 * a Blob and playing its object URL.
 */
export function CloudMediaPlayerDialog({
  item,
  items = [],
  onChangeItem,
  onClose,
}: Props) {
  const open = Boolean(item);
  const itemId = item?.id ?? "";

  const [mode, setMode] = useState<PlaybackMode>("stream");
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<PlaybackSource | null>(null);
  const [status, setStatus] = useState<PlayerStatus>("connecting");
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const blobControlRef = useRef<CloudBlobDownload | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const activeItemIdRef = useRef("");

  // Resolve a playback source for the current item / mode.
  useEffect(() => {
    if (!item) {
      activeItemIdRef.current = "";
      setSource(null);
      return;
    }

    // A new Watch item always starts on the streaming path again. If the
    // previous item was on the blob fallback, switch modes and let the next
    // effect run start streaming — don't begin buffering the new item first.
    if (activeItemIdRef.current !== item.id) {
      activeItemIdRef.current = item.id;
      if (mode !== "stream") {
        setMode("stream");
        setSource(null);
        setStatus("connecting");
        setProgress(0);
        setSpeed(null);
        setErrorMessage(null);
        setDownloadError(null);
        return;
      }
    }

    let cancelled = false;

    const cleanupBlob = () => {
      blobControlRef.current?.cancel();
      blobControlRef.current = null;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };

    setSource(null);
    setStatus(mode === "blob" ? "preparing" : "connecting");
    setProgress(0);
    setSpeed(null);
    setErrorMessage(null);
    setDownloadError(null);

    const run = async () => {
      if (mode === "stream") {
        const controlled = await ensureWatchStreamWorker();
        if (cancelled) return;
        if (!controlled) {
          setMode("blob");
          return;
        }

        const registered = await registerWatchStream(item);
        if (cancelled) {
          // Clean up an in-flight registration that finished after unmount.
          if (registered) unregisterWatchStream(item.id);
          return;
        }
        if (!registered) {
          setMode("blob");
          return;
        }

        const probe = await probeWatchStream(item.id);
        if (cancelled) return;

        if (!probe.ok) {
          if (probe.error === "corrupt" || probe.status === 422) {
            setStatus("error");
            setErrorMessage(
              "This cloud file appears incomplete or corrupt. Re-upload it from the worker and try again.",
            );
            return;
          }
          if (probe.status === 429) {
            setStatus("error");
            setErrorMessage("Cloud transfer quota exceeded. Try again later.");
            return;
          }
          if (probe.status === 404 && probe.error === "not-found") {
            setStatus("error");
            setErrorMessage("This file was not found in cloud storage.");
            return;
          }
          // Worker not ready, virtual request not intercepted, or an upstream
          // error the blob path may recover from.
          setMode("blob");
          return;
        }

        setProgress(1);
        setStatus("loading");
        setSource({ kind: "direct", url: cloudStreamUrl(item.id) });
        return;
      }

      // Blob fallback buffers the entire decrypted file in memory.
      if ((item.fileSize ?? 0) > BLOB_FALLBACK_WARN_BYTES) {
        const proceed = window.confirm(
          "This browser cannot stream this cloud file directly. Downloading it fully may use a lot of memory. Continue?",
        );
        if (!proceed) {
          setStatus("error");
          setErrorMessage("Playback canceled.");
          return;
        }
      }

      let previousBytes = 0;
      let previousAt = Date.now();
      const control = downloadCloudFileToBlob(
        item.sourceUrl,
        item.mimeType,
        (received, total) => {
          if (cancelled) return;
          const now = Date.now();
          const elapsed = (now - previousAt) / 1000;
          if (elapsed >= 0.25) {
            setSpeed((received - previousBytes) / elapsed);
            previousBytes = received;
            previousAt = now;
          }
          setProgress(total > 0 ? received / total : 0);
        },
      );
      blobControlRef.current = control;

      try {
        const blob = await control.promise;
        if (cancelled) return;
        blobControlRef.current = null;

        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setProgress(1);
        setStatus("loading");
        setSource({ kind: "direct", url });
      } catch (error: unknown) {
        if (cancelled) return;
        const caught = error as { name?: string; message?: string };
        if (caught?.name === "AbortError") return;
        setStatus("error");
        setErrorMessage(caught?.message ?? "Could not download this file for playback.");
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (mode === "stream") unregisterWatchStream(item.id);
      cleanupBlob();
    };
  }, [itemId, mode, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDownload = async () => {
    if (!item || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const control = downloadCloudFileToDisk(
        item.sourceUrl,
        item.name,
        item.fileSize ?? 0,
      );
      await control.promise;
    } catch (error: unknown) {
      const caught = error as { name?: string; message?: string };
      if (caught?.name !== "AbortError") {
        setDownloadError(caught?.message ?? "Could not download this file");
      }
    } finally {
      setDownloading(false);
    }
  };

  const handlePlaybackFailure = (message: string) => {
    if (mode === "stream") {
      setMode("blob");
      return;
    }
    setStatus("error");
    setErrorMessage(message);
  };

  const handleRetry = () => {
    if (mode === "blob") {
      setMode("stream");
      setAttempt((value) => value + 1);
      return;
    }
    setAttempt((value) => value + 1);
  };

  // Some browsers accept the service-worker response but never become ready
  // (notably older Safari/WebKit media stacks). Fall back to the blob path if
  // streaming does not produce a playable source within a reasonable window.
  useEffect(() => {
    if (!item || mode !== "stream") return;
    if (status === "ready" || status === "error") return;
    const timer = window.setTimeout(() => setMode("blob"), 30_000);
    return () => window.clearTimeout(timer);
  }, [itemId, mode, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentIndex = item
    ? items.findIndex((candidate) => candidate.id === item.id)
    : -1;
  const previousItem = currentIndex > 0 ? items[currentIndex - 1] : undefined;
  const nextItem =
    currentIndex >= 0 && currentIndex < items.length - 1
      ? items[currentIndex + 1]
      : undefined;

  const watchFile: WatchFile | null = item
    ? {
        index: 0,
        name: item.name,
        size: item.fileSize ?? 0,
        kind: item.kind,
        downloadId: item.id,
        downloadName: item.name,
      }
    : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden rounded-xl border-0 bg-black p-0 sm:max-w-5xl lg:max-w-6xl"
      >
        <DialogTitle className="sr-only">
          {item?.name ?? "Cloud media player"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {item ? `Streaming from ${providerLabel(item.provider)}` : "Cloud media player"}
        </DialogDescription>

        {item && watchFile && (
          <MediaPlayer
            key={`${item.id}:${mode}:${attempt}`}
            workerId="cloud"
            workerName={`${providerLabel(item.provider)} Cloud`}
            file={watchFile}
            source={source}
            urls={null}
            status={status}
            progress={progress}
            speed={mode === "blob" ? null : speed}
            sourceHeight={null}
            targetHeight={null}
            preparingLabel="Downloading for playback…"
            preparingDetail="Your browser could not stream this cloud file directly, so it is being downloaded locally. This only happens once."
            loadingDetail="Streaming securely from cloud storage."
            errorHint="The cloud file may have been removed, the link may have expired, or this browser cannot decode the format."
            errorMessage={errorMessage}
            downloading={downloading}
            downloadError={downloadError}
            onDismissDownloadError={() => setDownloadError(null)}
            audioTracks={[]}
            subtitleTracks={[]}
            chapters={[]}
            onDownload={() => void handleDownload()}
            onClose={onClose}
            onRetry={handleRetry}
            onSourceError={() =>
              handlePlaybackFailure("This file could not be played in this browser.")
            }
            onPlaybackError={(message) => handlePlaybackFailure(message)}
            onReady={() => setStatus("ready")}
            onNextFile={
              nextItem && onChangeItem ? () => onChangeItem(nextItem) : undefined
            }
            onPreviousFile={
              previousItem && onChangeItem
                ? () => onChangeItem(previousItem)
                : undefined
            }
            hasNext={Boolean(nextItem && onChangeItem)}
            hasPrevious={Boolean(previousItem && onChangeItem)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
