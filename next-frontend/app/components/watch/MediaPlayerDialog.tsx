"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Download, Loader2, Music, Video } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  downloadWorkerLocalFile,
  getWorkerMediaStatus,
  getWorkerMediaTicket,
  getWorkerPlaybackUrls,
  isFreePinggyPlaybackUrl,
  prepareWorkerMedia,
  type WorkerMediaMode,
  type WorkerPlaybackUrls,
} from "@/app/lib/workerConnection";
import { isNativePlayable, playbackCapabilitiesString } from "@/app/lib/media";
import type { WatchFile } from "./types";

interface Props {
  workerId: string | null;
  workerName?: string;
  file: WatchFile | null;
  onClose: () => void;
}

type PlayerStatus = "connecting" | "preparing" | "loading" | "ready" | "error";

type SourceKind = "direct" | "progressive" | "hls";

interface PlaybackSource {
  kind: SourceKind;
  url: string;
}

interface DestroyableHls {
  destroy: () => void;
}

const STATUS_POLL_MS = 1000;

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Inline player for worker-local media.
 *
 * The worker prepares one of two artifacts and the browser plays it directly
 * (media never passes through the app server):
 *
 *  * copy-safe codecs are remuxed once into an MP4 with HTTP range support —
 *    exact duration, instant seeking, no HLS involved;
 *  * everything else is served as a VOD HLS playlist whose segments are
 *    transcoded on demand — the full duration is known up front, so playback
 *    starts at 0:00 and seeking works everywhere.
 *
 * Native containers are still tried first; anything the browser rejects falls
 * back to the worker, and a broken prepared copy falls back to HLS. Free Pinggy
 * tunnels go straight to HLS because a raw <video> request cannot attach the
 * tunnel's browser-screening bypass header.
 */
export function MediaPlayerDialog({ workerId, workerName, file, onClose }: Props) {
  const open = Boolean(file && workerId);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const hlsRef = useRef<DestroyableHls | null>(null);

  // Pipeline bookkeeping. "attempt" restarts the whole flow after a fallback.
  const activeFileRef = useRef("");
  const attemptRef = useRef(0);
  const forceWorkerRef = useRef(false);
  const forceHlsRef = useRef(false);

  const [attempt, setAttempt] = useState(0);
  const [urls, setUrls] = useState<WorkerPlaybackUrls | null>(null);
  const [source, setSource] = useState<PlaybackSource | null>(null);
  const [status, setStatus] = useState<PlayerStatus>("connecting");
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState<number | null>(null);
  const [sourceHeight, setSourceHeight] = useState<number | null>(null);
  const [targetHeight, setTargetHeight] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const fileKey = file ? `${file.downloadId}:${file.index}` : "";

  const handleDownload = async () => {
    if (!workerId || !file || downloading) return;
    setDownloading(true);
    try {
      await downloadWorkerLocalFile(workerId, file.downloadId, file).promise;
    } catch (error: any) {
      // A cancelled save picker is a clean no-op.
      if (error?.name !== "AbortError") {
        setErrorMessage(error?.message ?? "Could not download this file");
      }
    } finally {
      setDownloading(false);
    }
  };

  // ── Pipeline: ticket → (native | prepare | HLS) → playback source ──────────
  useEffect(() => {
    if (!open || !workerId || !file) {
      // A fresh open should not inherit a previous attempt's fallbacks.
      activeFileRef.current = "";
      return;
    }

    if (activeFileRef.current !== fileKey) {
      activeFileRef.current = fileKey;
      attemptRef.current = 0;
      forceWorkerRef.current = false;
      forceHlsRef.current = false;
    }

    let cancelled = false;
    setUrls(null);
    setSource(null);
    setStatus("connecting");
    setProgress(0);
    setSpeed(null);
    setSourceHeight(null);
    setTargetHeight(null);
    setErrorMessage(null);

    // What this browser can decode. The worker uses it to decide whether the
    // video can be copied (fast, instant seeking) or must be re-encoded.
    const caps = playbackCapabilitiesString();

    const applyStatus = (state: { progress: number; speed: number | null; height: number | null; targetHeight: number | null }) => {
      setProgress(state.progress);
      setSpeed(state.speed);
      setSourceHeight(state.height);
      setTargetHeight(state.targetHeight);
    };

    const workerPath = async (mode: WorkerMediaMode, playbackUrls: WorkerPlaybackUrls) => {
      if (forceHlsRef.current || mode === "hls") {
        setStatus("loading");
        setSource({ kind: "hls", url: playbackUrls.hlsUrl });
        return;
      }

      // Progressive mode: the worker is remuxing the file into a seekable
      // MP4. Wait until it is ready so playback starts at the very beginning
      // with a full timeline.
      setStatus("preparing");
      let state = await prepareWorkerMedia(workerId, file.downloadId, file.index, caps);
      if (cancelled) return;
      applyStatus(state);
      while (state.state === "preparing") {
        await wait(STATUS_POLL_MS);
        if (cancelled) return;
        state = await getWorkerMediaStatus(workerId, file.downloadId, file.index, caps);
        if (cancelled) return;
        applyStatus(state);
      }
      if (state.state !== "ready") {
        throw new Error(state.detail ?? "This file could not be prepared for playback");
      }
      setStatus("loading");
      setSource({ kind: "progressive", url: playbackUrls.progressiveUrl });
    };

    const run = async () => {
      const ticket = await getWorkerMediaTicket(workerId, file.downloadId, file.index, caps);
      if (cancelled) return;
      setSourceHeight(ticket.height);
      setTargetHeight(ticket.targetHeight);
      const playbackUrls = await getWorkerPlaybackUrls(
        workerId,
        file.downloadId,
        file.index,
        ticket.token,
        caps,
      );
      if (cancelled) return;
      setUrls(playbackUrls);

      if (isFreePinggyPlaybackUrl(playbackUrls.hlsUrl)) {
        // A free Pinggy tunnel screens plain browser requests, and <video>
        // cannot send its bypass header. hls.js can, so use HLS directly
        // instead of preparing an MP4 that is guaranteed to fail to load.
        setStatus("loading");
        setSource({ kind: "hls", url: playbackUrls.hlsUrl });
        return;
      }

      if (!forceWorkerRef.current && isNativePlayable(file.name)) {
        // The browser can probably play this container as-is (no worker work).
        setStatus("loading");
        setSource({ kind: "direct", url: playbackUrls.directUrl });
        return;
      }
      await workerPath(ticket.mode, playbackUrls);
    };

    run().catch((error: unknown) => {
      if (cancelled) return;
      setStatus("error");
      setErrorMessage(
        error instanceof Error ? error.message : "Could not prepare this file for playback",
      );
    });

    return () => {
      cancelled = true;
    };
  }, [open, workerId, fileKey, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Attach the selected source to the media element ────────────────────────
  useEffect(() => {
    if (!open || !file || !source || !urls) return;
    const media = mediaRef.current;
    if (!media) return;

    let disposed = false;

    const destroyHls = () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };

    const resetMedia = () => {
      try {
        media.pause();
        media.removeAttribute("src");
        media.load();
      } catch {
        /* the element may already be detached */
      }
    };

    // First decoded frame (or audio sample) is ready — hide the overlay.
    const onLoadedData = () => {
      if (!disposed) setStatus("ready");
    };
    media.addEventListener("loadeddata", onLoadedData);

    // Safari plays HLS through the media element itself, so failures surface
    // as element errors instead of hls.js events.
    let usingNativeHls = false;

    const attachHls = async () => {
      try {
        const { default: Hls } = await import("hls.js");
        if (disposed) return;

        // Safari plays HLS natively; there is no way to add the Pinggy header,
        // but the ticket in the playlist/segment URLs still authorizes it.
        if (!Hls.isSupported()) {
          usingNativeHls = true;
          media.src = source.url;
          media.load();
          void media.play().catch(() => undefined);
          return;
        }

        const hls = new Hls({
          // Transcodes are produced on demand: buffer generously and retry
          // patiently so a slow segment never kills playback.
          maxBufferLength: 60,
          maxMaxBufferLength: 120,
          fragLoadingMaxRetry: 12,
          fragLoadingRetryDelay: 1000,
          fragLoadingMaxRetryTimeout: 8000,
          startPosition: 0,
          xhrSetup: (xhr) => {
            // Pinggy Free screens browser requests unless this header is set.
            xhr.setRequestHeader("X-Pinggy-No-Screen", "1");
          },
        });
        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (disposed) return;
          // The playlist is complete VOD, so hls.js plays from 0:00 and the
          // worker produces segments as they are requested.
          void media.play().catch(() => undefined);
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (disposed || !data?.fatal) return;
          setStatus("error");
          const statusCode = (data as { response?: { code?: number } }).response?.code;
          setErrorMessage(
            statusCode === 503
              ? "The worker could not prepare this file for playback."
              : data.type === Hls.ErrorTypes.NETWORK_ERROR
                ? "Could not reach the worker — is it still online?"
                : "This file could not be played on this worker.",
          );
          destroyHls();
        });

        hls.loadSource(source.url);
        hls.attachMedia(media);
      } catch {
        if (!disposed) {
          setStatus("error");
          setErrorMessage("This file could not be played on this worker.");
        }
      }
    };

    if (source.kind === "hls") {
      resetMedia();
      const onNativeHlsError = () => {
        if (disposed || !usingNativeHls) return;
        setStatus("error");
        setErrorMessage("This file could not be played in this browser.");
      };
      media.addEventListener("error", onNativeHlsError);
      void attachHls();

      return () => {
        disposed = true;
        media.removeEventListener("error", onNativeHlsError);
        media.removeEventListener("loadeddata", onLoadedData);
        destroyHls();
        resetMedia();
      };
    }

    // Direct file or prepared copy: a plain media element the browser can seek
    // in (the worker supports HTTP range requests).
    resetMedia();
    const onError = () => {
      if (disposed) return;
      media.removeEventListener("error", onError);
      if (source.kind === "direct") {
        // Unsupported codec/container or Pinggy screening — use the worker.
        forceWorkerRef.current = true;
      } else {
        // The prepared copy could not be decoded — fall back to transcoding.
        forceHlsRef.current = true;
      }
      attemptRef.current += 1;
      setAttempt(attemptRef.current);
    };
    media.addEventListener("error", onError);
    media.src = source.url;
    media.load();
    void media.play().catch(() => undefined);

    return () => {
      disposed = true;
      media.removeEventListener("error", onError);
      media.removeEventListener("loadeddata", onLoadedData);
      destroyHls();
      resetMedia();
    };
  }, [open, fileKey, source, urls]); // eslint-disable-line react-hooks/exhaustive-deps

  const kind = file?.kind ?? "video";
  const progressPct = Math.round(progress * 100);
  const speedLabel =
    speed != null && speed > 0
      ? `${speed >= 10 ? Math.round(speed) : speed.toFixed(1)}× realtime`
      : null;
  const downscaling =
    sourceHeight != null && targetHeight != null && targetHeight < sourceHeight;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="p-0 gap-0 overflow-hidden sm:max-w-3xl">
        {file && (
          <>
            <DialogHeader className="px-5 pt-5 pb-3 pr-12 text-left">
              <DialogTitle className="flex items-center gap-2 text-base">
                {kind === "video" ? (
                  <Video className="h-4 w-4 shrink-0" />
                ) : (
                  <Music className="h-4 w-4 shrink-0" />
                )}
                <span className="truncate">{file.name}</span>
              </DialogTitle>
              <DialogDescription className="text-xs">
                {workerName ? `${workerName} · ` : ""}
                Streaming directly from the worker
              </DialogDescription>
            </DialogHeader>

            <div className="relative bg-black">
              {kind === "video" ? (
                <video
                  ref={(el) => {
                    mediaRef.current = el;
                  }}
                  controls
                  playsInline
                  className="max-h-[70vh] w-full"
                />
              ) : (
                <div className="flex min-h-40 flex-col items-center justify-center gap-4 px-6 py-10">
                  <Music className="h-12 w-12 text-white/40" />
                  <audio
                    ref={(el) => {
                      mediaRef.current = el;
                    }}
                    controls
                    className="w-full max-w-xl"
                  />
                </div>
              )}

              {status !== "ready" && status !== "error" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-6 text-center text-white">
                  <Loader2 className="h-7 w-7 animate-spin" />
                  {status === "preparing" ? (
                    <>
                      <p className="text-sm">
                        Preparing stream… {progressPct}%
                        {speedLabel ? ` · ${speedLabel}` : ""}
                      </p>
                      <div className="h-1.5 w-56 overflow-hidden rounded-full bg-white/20">
                        <div
                          className="h-full rounded-full bg-white transition-[width] duration-500"
                          style={{ width: `${Math.max(3, progressPct)}%` }}
                        />
                      </div>
                      <p className="text-xs text-white/60">
                        {downscaling
                          ? `Converting ${sourceHeight}p to ${targetHeight}p on the worker — this only happens once.`
                          : "Converting on the worker so the timeline is exact — this only happens once."}
                      </p>
                      {speed != null && speed > 0 && speed < 1 && (
                        <p className="text-xs text-amber-300/90">
                          The worker is slower than realtime — this may take a while.
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="text-sm">Loading stream…</p>
                      <p className="text-xs text-white/60">
                        {downscaling
                          ? `Converting ${sourceHeight}p to ${targetHeight}p on the worker as you watch.`
                          : "Remote formats are converted on the worker — this can take a moment."}
                      </p>
                    </>
                  )}
                </div>
              )}

              {status === "error" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center text-white">
                  <AlertCircle className="h-7 w-7" />
                  <p className="text-sm">{errorMessage}</p>
                  <p className="text-xs text-white/60">
                    The file may have been removed or the worker may be offline.
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void handleDownload()}
                    disabled={downloading}
                    className="mt-1"
                  >
                    {downloading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    Download instead
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
