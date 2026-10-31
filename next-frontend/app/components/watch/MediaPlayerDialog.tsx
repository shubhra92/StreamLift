"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  downloadWorkerLocalFile,
  getWorkerMediaStatus,
  getWorkerMediaTicket,
  getWorkerPlaybackUrls,
  isFreePinggyPlaybackUrl,
  prepareWorkerMedia,
  type WorkerAudioTrack,
  type WorkerChapter,
  type WorkerMediaMode,
  type WorkerMediaStatus,
  type WorkerPlaybackUrls,
  type WorkerSubtitleTrack,
} from "@/app/lib/workerConnection";
import { isNativePlayable, playbackCapabilitiesString } from "@/app/lib/media";
import { MediaPlayer } from "./player/MediaPlayer";
import type {
  PlaybackSource,
  PlayerStatus,
  SourceKind,
} from "./player/types";
import type { WatchFile } from "./types";

interface Props {
  workerId: string | null;
  workerName?: string;
  file: WatchFile | null;
  files?: WatchFile[];
  onChangeFile?: (file: WatchFile) => void;
  onClose: () => void;
}

const STATUS_POLL_MS = 1000;

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Mirrors the worker's playback contract:
 *
 *  * single-audio files keep the fast path — progressive MP4 when the codec
 *    can be copied, HLS only when the video must be re-encoded;
 *  * multi-audio files are delivered as an HLS master playlist with one
 *    alternate-audio rendition per track, so switching never reloads;
 *  * subtitles are embedded-track WebVTT served by the worker and rendered by
 *    the custom player, which gives full control over appearance.
 */
export function MediaPlayerDialog({
  workerId,
  workerName,
  file,
  files = [],
  onChangeFile,
  onClose,
}: Props) {
  const open = Boolean(file && workerId);

  const activeFileRef = useRef("");
  const attemptRef = useRef(0);
  const forceWorkerRef = useRef(false);
  const forceHlsRef = useRef(false);

  const [attempt, setAttempt] = useState(0);
  const [pipelineFileKey, setPipelineFileKey] = useState("");
  const [urls, setUrls] = useState<WorkerPlaybackUrls | null>(null);
  const [source, setSource] = useState<PlaybackSource | null>(null);
  const [status, setStatus] = useState<PlayerStatus>("connecting");
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState<number | null>(null);
  const [sourceHeight, setSourceHeight] = useState<number | null>(null);
  const [targetHeight, setTargetHeight] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [audioTracks, setAudioTracks] = useState<WorkerAudioTrack[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<WorkerSubtitleTrack[]>([]);
  const [chapters, setChapters] = useState<WorkerChapter[]>([]);

  const fileKey = file ? `${file.downloadId}:${file.index}` : "";

  const handleDownload = async () => {
    if (!workerId || !file || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadWorkerLocalFile(workerId, file.downloadId, file).promise;
    } catch (error: unknown) {
      const caught = error as { name?: string; message?: string };
      if (caught?.name !== "AbortError") {
        setDownloadError(caught?.message ?? "Could not download this file");
      }
    } finally {
      setDownloading(false);
    }
  };

  const handleSourceError = (kind: SourceKind) => {
    // Fall back one step at a time: direct → worker, then progressive → HLS.
    // HLS is the last resort, so a failure there must stop and wait for an
    // explicit Retry instead of reloading the same source forever.
    if (kind === "direct") {
      if (forceWorkerRef.current) return;
      forceWorkerRef.current = true;
    } else if (kind === "progressive") {
      if (forceHlsRef.current) return;
      forceHlsRef.current = true;
    } else {
      return;
    }
    attemptRef.current += 1;
    setAttempt(attemptRef.current);
  };

  const handleRetry = () => {
    attemptRef.current += 1;
    setAttempt(attemptRef.current);
  };

  // ── Pipeline: ticket → (native | prepare | HLS) → playback source ──────────
  useEffect(() => {
    if (!open || !workerId || !file) {
      activeFileRef.current = "";
      setPipelineFileKey("");
      setUrls(null);
      setSource(null);
      return;
    }

    if (activeFileRef.current !== fileKey) {
      activeFileRef.current = fileKey;
      forceWorkerRef.current = false;
      forceHlsRef.current = false;
    }

    setPipelineFileKey(fileKey);

    let cancelled = false;
    setUrls(null);
    setSource(null);
    setStatus("connecting");
    setProgress(0);
    setSpeed(null);
    setSourceHeight(null);
    setTargetHeight(null);
    setErrorMessage(null);
    setDownloadError(null);
    setAudioTracks([]);
    setSubtitleTracks([]);
    setChapters([]);

    const caps = playbackCapabilitiesString();

    const applyStatus = (state: WorkerMediaStatus) => {
      setProgress(state.progress);
      setSpeed(state.speed);
      setSourceHeight(state.height);
      setTargetHeight(state.targetHeight);
    };

    const workerPath = async (
      mode: WorkerMediaMode,
      playbackUrls: WorkerPlaybackUrls,
      rendered: boolean,
    ) => {
      if (forceHlsRef.current || rendered || mode === "hls") {
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
      const ticket = await getWorkerMediaTicket(
        workerId,
        file.downloadId,
        file.index,
        caps,
      );
      if (cancelled) return;

      setAudioTracks(ticket.audioTracks);
      setSubtitleTracks(ticket.subtitleTracks);
      setChapters(ticket.chapters);
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

      const needsTrackStream = ticket.multiAudio || ticket.audioTracks.length > 1;

      if (
        !forceWorkerRef.current &&
        !needsTrackStream &&
        isNativePlayable(file.name)
      ) {
        // The browser can probably play this container as-is (no worker work),
        // and there is only one audio track, so native controls are enough.
        setStatus("loading");
        setSource({ kind: "direct", url: playbackUrls.directUrl });
        return;
      }

      await workerPath(ticket.mode, playbackUrls, ticket.rendered);
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

  const currentIndex = file
    ? files.findIndex(
        (candidate) =>
          candidate.downloadId === file.downloadId && candidate.index === file.index,
      )
    : -1;
  const previousFile =
    currentIndex > 0 ? files[currentIndex - 1] : undefined;
  const nextFile =
    currentIndex >= 0 && currentIndex < files.length - 1
      ? files[currentIndex + 1]
      : undefined;
  const pipelineReady = Boolean(fileKey) && pipelineFileKey === fileKey;

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
        <DialogTitle className="sr-only">{file?.name ?? "Media player"}</DialogTitle>
        <DialogDescription className="sr-only">
          {workerName ? `Streaming from ${workerName}` : "Streaming from your worker"}
        </DialogDescription>

        {file && workerId && (
          <MediaPlayer
            key={fileKey}
            workerId={workerId}
            workerName={workerName}
            file={file}
            source={pipelineReady ? source : null}
            urls={pipelineReady ? urls : null}
            status={pipelineReady ? status : "connecting"}
            progress={pipelineReady ? progress : 0}
            speed={pipelineReady ? speed : null}
            sourceHeight={pipelineReady ? sourceHeight : null}
            targetHeight={pipelineReady ? targetHeight : null}
            errorMessage={pipelineReady ? errorMessage : null}
            downloading={downloading}
            downloadError={downloadError}
            onDismissDownloadError={() => setDownloadError(null)}
            audioTracks={pipelineReady ? audioTracks : []}
            subtitleTracks={pipelineReady ? subtitleTracks : []}
            chapters={pipelineReady ? chapters : []}
            onDownload={() => void handleDownload()}
            onClose={onClose}
            onRetry={handleRetry}
            onSourceError={handleSourceError}
            onPlaybackError={(message) => {
              setStatus("error");
              setErrorMessage(message);
            }}
            onReady={() => setStatus("ready")}
            onNextFile={
              nextFile && onChangeFile ? () => onChangeFile(nextFile) : undefined
            }
            onPreviousFile={
              previousFile && onChangeFile
                ? () => onChangeFile(previousFile)
                : undefined
            }
            hasNext={Boolean(nextFile && onChangeFile)}
            hasPrevious={Boolean(previousFile && onChangeFile)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
