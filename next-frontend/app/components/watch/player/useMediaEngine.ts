"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type HlsType from "hls.js";
import { isFreePinggyPlaybackUrl, getTunnelBypassHeaders } from "@/app/lib/workerConnection";
import type { PlaybackSource, SourceKind } from "./types";

export interface EngineAudioTrack {
  id: number;
  label: string;
  language: string | null;
  channels: number | null;
  default: boolean;
}

export interface EngineLevel {
  id: number;
  name: string;
  height: number;
  width: number;
  bitrate: number;
}

interface VideoBufferedRange {
  start: number;
  end: number;
}

function mergeVideoRange(
  ranges: VideoBufferedRange[],
  start: number,
  end: number,
): VideoBufferedRange[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return ranges;
  }
  const next = [...ranges, { start, end }].sort((a, b) => a.start - b.start);
  const merged: VideoBufferedRange[] = [];
  for (const range of next) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end + 0.1) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

function removeVideoRange(
  ranges: VideoBufferedRange[],
  start: number,
  end: number,
): VideoBufferedRange[] {
  const remaining: VideoBufferedRange[] = [];
  for (const range of ranges) {
    if (range.end <= start || range.start >= end) {
      remaining.push(range);
      continue;
    }
    if (range.start < start) {
      remaining.push({ start: range.start, end: start });
    }
    if (range.end > end) {
      remaining.push({ start: end, end: range.end });
    }
  }
  return remaining;
}

function mediaBufferAhead(media: HTMLMediaElement): number {
  try {
    const time = media.currentTime;
    for (let index = 0; index < media.buffered.length; index += 1) {
      if (time >= media.buffered.start(index) && time <= media.buffered.end(index)) {
        return Math.max(0, media.buffered.end(index) - time);
      }
    }
  } catch {
    /* buffered ranges may be unavailable during teardown */
  }
  return 0;
}

function videoBufferAheadFromRanges(
  ranges: VideoBufferedRange[],
  time: number,
): number {
  let end = time;
  let found = false;
  for (const range of ranges) {
    if (time >= range.start - 0.05 && time <= range.end + 0.05) {
      end = Math.max(end, range.end);
      found = true;
      break;
    }
  }
  if (!found) {
    // hls.js can append the next fragment just after the reported playhead.
    for (const range of ranges) {
      if (range.start - time <= 0.25 && range.end > time) {
        end = Math.max(end, range.end);
        found = true;
        break;
      }
    }
  }
  if (!found) return 0;

  let grew = true;
  while (grew) {
    grew = false;
    for (const range of ranges) {
      if (range.start <= end + 0.1 && range.end > end) {
        end = range.end;
        grew = true;
      }
    }
  }
  return Math.max(0, end - time);
}

interface Options {
  mediaRef: RefObject<HTMLMediaElement | null>;
  source: PlaybackSource | null;
  fileKey: string;
  onReady: () => void;
  onSourceError: (kind: SourceKind) => void;
  onPlaybackError: (message: string) => void;
}

interface MediaEngine {
  audioTracks: EngineAudioTrack[];
  selectedAudio: number | null;
  selectAudio: (id: number) => void;
  switchableAudio: boolean;
  levels: EngineLevel[];
  currentLevel: number;
  autoLevel: boolean;
  selectQuality: (level: number | "auto") => void;
  bandwidthEstimate: number | null;
  engineLabel: "hls.js" | "native" | "direct" | null;
  videoBufferAhead: () => number;
}

interface NativeAudioTrackLike {
  label?: string;
  language?: string;
  enabled: boolean;
}

function readNativeAudioTracks(
  media: HTMLMediaElement,
): { tracks: EngineAudioTrack[]; selected: number | null } {
  const list = (media as unknown as { audioTracks?: ArrayLike<NativeAudioTrackLike> }).audioTracks;
  if (!list || typeof list.length !== "number" || list.length === 0) {
    return { tracks: [], selected: null };
  }
  const tracks: EngineAudioTrack[] = [];
  let selected: number | null = null;
  for (let index = 0; index < list.length; index += 1) {
    const track = list[index];
    if (!track) continue;
    tracks.push({
      id: index,
      label: track.label || track.language || `Track ${index + 1}`,
      language: track.language ?? null,
      channels: null,
      default: index === 0,
    });
    if (track.enabled) selected = index;
  }
  return { tracks, selected };
}

export function useMediaEngine({
  mediaRef,
  source,
  fileKey,
  onReady,
  onSourceError,
  onPlaybackError,
}: Options): MediaEngine {
  const hlsRef = useRef<HlsType | null>(null);
  const onReadyRef = useRef(onReady);
  const onSourceErrorRef = useRef(onSourceError);
  const onPlaybackErrorRef = useRef(onPlaybackError);
  onReadyRef.current = onReady;
  onSourceErrorRef.current = onSourceError;
  onPlaybackErrorRef.current = onPlaybackError;

  const [audioTracks, setAudioTracks] = useState<EngineAudioTrack[]>([]);
  const [selectedAudio, setSelectedAudio] = useState<number | null>(null);
  const [levels, setLevels] = useState<EngineLevel[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [autoLevel, setAutoLevel] = useState(true);
  const [bandwidthEstimate, setBandwidthEstimate] = useState<number | null>(null);
  const [engineLabel, setEngineLabel] = useState<MediaEngine["engineLabel"]>(null);
  const nativeTracksRef = useRef<EngineAudioTrack[]>([]);
  const videoBufferedRangesRef = useRef<VideoBufferedRange[]>([]);
  const usingHlsJsRef = useRef(false);

  const videoBufferAhead = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return 0;
    if (!usingHlsJsRef.current) {
      // Direct/progressive/native HLS multiplex audio and video into the same
      // media timeline, so the normal buffered range is enough.
      return mediaBufferAhead(media);
    }
    return videoBufferAheadFromRanges(
      videoBufferedRangesRef.current,
      media.currentTime,
    );
  }, [mediaRef]);

  const selectAudio = useCallback(
    (id: number) => {
      const hls = hlsRef.current;
      if (hls && hls.audioTracks.length > 0) {
        if (id >= 0 && id < hls.audioTracks.length) {
          hls.audioTrack = id;
          setSelectedAudio(id);
        }
        return;
      }
      const media = mediaRef.current;
      const list = (media as unknown as { audioTracks?: ArrayLike<NativeAudioTrackLike> })
        ?.audioTracks;
      if (!list) return;
      for (let index = 0; index < list.length; index += 1) {
        const track = list[index];
        if (track) track.enabled = index === id;
      }
      setSelectedAudio(id);
      nativeTracksRef.current = nativeTracksRef.current.map((track) => ({
        ...track,
        default: track.id === id,
      }));
    },
    [mediaRef],
  );

  const selectQuality = useCallback((level: number | "auto") => {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.currentLevel = level === "auto" ? -1 : level;
    setAutoLevel(level === "auto");
    setCurrentLevel(level === "auto" ? -1 : level);
  }, []);

  useEffect(() => {
    if (!source || !fileKey) return;
    const media = mediaRef.current;
    if (!media) return;

    let disposed = false;
    let nativeHls = false;
    setAudioTracks([]);
    setSelectedAudio(null);
    setLevels([]);
    setCurrentLevel(-1);
    setAutoLevel(true);
    setBandwidthEstimate(null);
    setEngineLabel(null);
    nativeTracksRef.current = [];
    videoBufferedRangesRef.current = [];
    usingHlsJsRef.current = false;

    const destroyHls = () => {
      const hls = hlsRef.current;
      hlsRef.current = null;
      usingHlsJsRef.current = false;
      videoBufferedRangesRef.current = [];
      if (hls) {
        try {
          hls.destroy();
        } catch {
          /* already destroyed */
        }
      }
    };

    const resetMedia = () => {
      try {
        media.pause();
        media.removeAttribute("src");
        media.load();
      } catch {
        /* element may be detached */
      }
    };

    const onLoadedData = () => {
      if (disposed) return;
      onReadyRef.current();
      syncNativeTracks();
    };

    const syncNativeTracks = () => {
      if (disposed) return;
      const result = readNativeAudioTracks(media);
      nativeTracksRef.current = result.tracks;
      if (result.tracks.length > 0) {
        setAudioTracks(result.tracks);
        setSelectedAudio((current) => current ?? result.selected ?? 0);
        setEngineLabel((current) => current ?? "native");
      }
    };

    const onNativeAudioTrackAdded = () => syncNativeTracks();

    media.addEventListener("loadeddata", onLoadedData);
    media.addEventListener("loadedmetadata", syncNativeTracks);
    const nativeList = (
      media as unknown as {
        audioTracks?: EventTarget & ArrayLike<NativeAudioTrackLike>;
      }
    ).audioTracks;
    nativeList?.addEventListener?.("addtrack", onNativeAudioTrackAdded);
    nativeList?.addEventListener?.("removetrack", onNativeAudioTrackAdded);

    const onDirectError = () => {
      if (disposed) return;
      if (source.kind === "hls") {
        if (nativeHls) {
          onPlaybackErrorRef.current("This file could not be played in this browser.");
        }
        return;
      }
      onSourceErrorRef.current(source.kind);
    };
    media.addEventListener("error", onDirectError);

    const attachHls = async () => {
      try {
        const { default: Hls } = await import("hls.js");
        if (disposed) return;

        if (!Hls.isSupported()) {
          nativeHls = true;
          setEngineLabel("native");
          media.src = source.url;
          media.load();
          void media.play().catch(() => undefined);
          return;
        }

        setEngineLabel("hls.js");
        const needsPinggyBypass = isFreePinggyPlaybackUrl(source.url);
        const hls = new Hls({
          maxBufferLength: 60,
          maxMaxBufferLength: 120,
          backBufferLength: 90,
          fragLoadingMaxRetry: 12,
          fragLoadingRetryDelay: 1000,
          fragLoadingMaxRetryTimeout: 8000,
          manifestLoadingMaxRetry: 4,
          startPosition: 0,
          enableWorker: true,
          // Pinggy Free and Serveo free tier both screen browser requests
          // unless their respective bypass headers are set. Headers are
          // derived from the URL by getTunnelBypassHeaders — no provider
          // knowledge lives here.
          ...(needsPinggyBypass
            ? {
                xhrSetup: (xhr: XMLHttpRequest) => {
                  const headers = getTunnelBypassHeaders(source.url);
                  Object.entries(headers).forEach(([k, v]) =>
                    xhr.setRequestHeader(k, v),
                  );
                },
              }
            : {}),
        });
        hlsRef.current = hls;
        usingHlsJsRef.current = true;

        hls.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
          if (disposed || data.id !== "main") return;
          const start = data.frag?.start;
          const duration = data.frag?.duration;
          if (
            typeof start !== "number" ||
            typeof duration !== "number" ||
            !Number.isFinite(start) ||
            !Number.isFinite(duration)
          ) {
            return;
          }
          videoBufferedRangesRef.current = mergeVideoRange(
            videoBufferedRangesRef.current,
            start,
            start + duration,
          );
        });
        hls.on(Hls.Events.BUFFER_RESET, () => {
          if (!disposed) videoBufferedRangesRef.current = [];
        });
        hls.on(Hls.Events.BUFFER_FLUSHED, (_event, data) => {
          if (disposed || data.type !== "video") return;
          videoBufferedRangesRef.current = removeVideoRange(
            videoBufferedRangesRef.current,
            data.start,
            data.end,
          );
        });

        const syncHlsAudio = () => {
          if (disposed) return;
          const tracks = hls.audioTracks.map((track, index) => ({
            id: index,
            label: track.name || track.lang || `Track ${index + 1}`,
            language: track.lang ?? null,
            channels: track.channels ? Number(track.channels) || null : null,
            default: Boolean(track.default),
          }));
          setAudioTracks(tracks);
          if (tracks.length > 0) {
            setSelectedAudio(hls.audioTrack >= 0 ? hls.audioTrack : 0);
          }
        };

        const syncLevels = () => {
          if (disposed) return;
          setLevels(
            hls.levels.map((level, index) => ({
              id: index,
              name: level.name || "",
              height: level.height || 0,
              width: level.width || 0,
              bitrate: level.bitrate || 0,
            })),
          );
          setCurrentLevel(hls.currentLevel);
          setAutoLevel(hls.autoLevelEnabled);
          setBandwidthEstimate((current) => hls.bandwidthEstimate || current);
        };

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (disposed) return;
          syncHlsAudio();
          syncLevels();
          void media.play().catch(() => undefined);
        });
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, syncHlsAudio);
        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, data) => {
          if (disposed) return;
          setSelectedAudio(data.id);
          setAudioTracks((current) =>
            current.map((track) => ({ ...track, default: track.id === data.id })),
          );
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
          if (disposed) return;
          setCurrentLevel(data.level);
          setAutoLevel(hls.autoLevelEnabled);
          setBandwidthEstimate(hls.bandwidthEstimate || null);
        });
        hls.on(Hls.Events.LEVEL_UPDATED, () => {
          if (disposed) return;
          setBandwidthEstimate(hls.bandwidthEstimate || null);
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (disposed || !data?.fatal) return;
          const statusCode = (data as { response?: { code?: number } }).response?.code;
          onPlaybackErrorRef.current(
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
          onPlaybackErrorRef.current("This file could not be played on this worker.");
        }
      }
    };

    resetMedia();

    if (source.kind === "hls") {
      void attachHls();
    } else {
      setEngineLabel("direct");
      media.src = source.url;
      media.load();
      void media.play().catch(() => undefined);
    }

    return () => {
      disposed = true;
      media.removeEventListener("loadeddata", onLoadedData);
      media.removeEventListener("loadedmetadata", syncNativeTracks);
      media.removeEventListener("error", onDirectError);
      nativeList?.removeEventListener?.("addtrack", onNativeAudioTrackAdded);
      nativeList?.removeEventListener?.("removetrack", onNativeAudioTrackAdded);
      destroyHls();
      resetMedia();
    };
  }, [fileKey, mediaRef, source]);

  const switchableAudio = audioTracks.length > 1;

  return {
    audioTracks,
    selectedAudio,
    selectAudio,
    switchableAudio,
    levels,
    currentLevel,
    autoLevel,
    selectQuality,
    bandwidthEstimate,
    engineLabel,
    videoBufferAhead,
  };
}
