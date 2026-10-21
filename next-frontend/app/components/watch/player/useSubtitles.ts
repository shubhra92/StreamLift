"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  isFreePinggyPlaybackUrl,
  type WorkerPlaybackUrls,
  type WorkerSubtitleTrack,
} from "@/app/lib/workerConnection";
import {
  loadSubtitleDelay,
  loadSubtitleSelection,
  loadSubtitleStyle,
  saveSubtitleDelay,
  saveSubtitleSelection,
  saveSubtitleStyle,
} from "./storage";
import { cuesAt, parseVtt } from "./subtitles";
import {
  DEFAULT_SUBTITLE_STYLE,
  type SubtitleCue,
  type SubtitleStyle,
} from "./types";

interface Options {
  mediaRef: RefObject<HTMLMediaElement | null>;
  tracks: WorkerSubtitleTrack[];
  urls: WorkerPlaybackUrls | null;
  fileKey: string;
}

interface SubtitleEngine {
  selectedId: number | null;
  selectSubtitle: (id: number | null) => void;
  activeCues: SubtitleCue[];
  loading: boolean;
  error: string | null;
  style: SubtitleStyle;
  updateStyle: (patch: Partial<SubtitleStyle>) => void;
  resetStyle: () => void;
  delay: number;
  setDelay: (delay: number) => void;
  hasTextTracks: boolean;
  hasBitmapTracks: boolean;
  toggleFirstTrack: () => void;
}

function resolveInitialTrack(
  fileKey: string,
  tracks: WorkerSubtitleTrack[],
): number | null {
  const saved = loadSubtitleSelection(fileKey);
  if (saved !== undefined) {
    if (saved < 0) return null;
    const match = tracks.find((track) => track.index === saved && !track.bitmap);
    return match ? match.index : null;
  }
  const preferred =
    tracks.find((track) => track.default && !track.bitmap) ??
    tracks.find((track) => track.forced && !track.bitmap) ??
    tracks.find((track) => !track.bitmap);
  return preferred?.index ?? null;
}

export function useSubtitles({
  mediaRef,
  tracks,
  urls,
  fileKey,
}: Options): SubtitleEngine {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [activeCues, setActiveCues] = useState<SubtitleCue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [style, setStyle] = useState<SubtitleStyle>(() => loadSubtitleStyle());
  const [delay, setDelayState] = useState(0);

  const initialisedFileRef = useRef("");
  const initialisedTrackCountRef = useRef(-1);
  const cacheRef = useRef(new Map<number, SubtitleCue[]>());
  const activeSignatureRef = useRef("");
  const lastSelectedTrackRef = useRef<number | null>(null);

  // Reset and pick the default track once the ticket (and its track list) for
  // this file is available. The worker may answer tickets in any order; if the
  // URL arrives before the track list, re-run when the tracks commit.
  useEffect(() => {
    if (!urls || !fileKey) return;
    if (
      initialisedFileRef.current === fileKey &&
      initialisedTrackCountRef.current === tracks.length
    ) {
      return;
    }
    initialisedFileRef.current = fileKey;
    initialisedTrackCountRef.current = tracks.length;
    cacheRef.current.clear();
    setCues([]);
    setActiveCues([]);
    activeSignatureRef.current = "";
    setDelayState(loadSubtitleDelay(fileKey));
    const initial = resolveInitialTrack(fileKey, tracks);
    lastSelectedTrackRef.current = initial;
    setSelectedId(initial);
  }, [fileKey, tracks, urls]);

  const selectSubtitle = useCallback(
    (id: number | null) => {
      setSelectedId(id);
      if (id !== null) lastSelectedTrackRef.current = id;
      if (fileKey) saveSubtitleSelection(fileKey, id);
    },
    [fileKey],
  );

  // Load the chosen track (cached per file).
  useEffect(() => {
    if (!urls || selectedId === null) {
      setCues([]);
      setLoading(false);
      setError(null);
      return;
    }

    const track = tracks.find((candidate) => candidate.index === selectedId);
    if (track?.bitmap) {
      setCues([]);
      setLoading(false);
      setError("Image-based subtitles cannot be displayed in a browser");
      return;
    }

    const cached = cacheRef.current.get(selectedId);
    if (cached) {
      setCues(cached);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const url = `${urls.subtitlesBaseUrl}/${selectedId}.vtt${urls.mediaQuery}`;
    const needsPinggyBypass = isFreePinggyPlaybackUrl(urls.hlsUrl);
    void (async () => {
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          ...(needsPinggyBypass
            ? { headers: { "X-Pinggy-No-Screen": "1" } }
            : {}),
        });
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? "This subtitle track is not available"
              : `Could not load subtitles (${response.status})`,
          );
        }
        const text = await response.text();
        if (cancelled) return;
        const parsed = parseVtt(text);
        cacheRef.current.set(selectedId, parsed);
        setCues(parsed);
        setError(parsed.length === 0 ? "This subtitle track is empty" : null);
      } catch (caught) {
        if (cancelled || (caught instanceof DOMException && caught.name === "AbortError")) {
          return;
        }
        setCues([]);
        setError(caught instanceof Error ? caught.message : "Could not load subtitles");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedId, tracks, urls]);

  // Track the active cue. 10 Hz is smoother than timeupdate (which only fires
  // ~4x/sec) and much cheaper than a requestAnimationFrame loop.
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    if (selectedId === null || cues.length === 0) {
      activeSignatureRef.current = "";
      setActiveCues([]);
      return;
    }

    const tick = () => {
      const active = cuesAt(cues, media.currentTime - delay);
      const signature = active.map((cue) => `${cue.start}:${cue.end}:${cue.text}`).join("|");
      if (signature === activeSignatureRef.current) return;
      activeSignatureRef.current = signature;
      setActiveCues(active);
    };

    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [cues, delay, fileKey, mediaRef, selectedId]);

  const updateStyle = useCallback((patch: Partial<SubtitleStyle>) => {
    setStyle((current) => {
      const next = { ...current, ...patch };
      saveSubtitleStyle(next);
      return next;
    });
  }, []);

  const resetStyle = useCallback(() => {
    setStyle(() => {
      saveSubtitleStyle(DEFAULT_SUBTITLE_STYLE);
      return { ...DEFAULT_SUBTITLE_STYLE };
    });
  }, []);

  const setDelay = useCallback(
    (value: number) => {
      const clamped = Math.max(-30, Math.min(30, Number(value.toFixed(2))));
      setDelayState(clamped);
      if (fileKey) saveSubtitleDelay(fileKey, clamped);
    },
    [fileKey],
  );

  const hasTextTracks = tracks.some((track) => !track.bitmap);
  const hasBitmapTracks = tracks.some((track) => track.bitmap);

  const toggleFirstTrack = useCallback(() => {
    if (selectedId !== null) {
      selectSubtitle(null);
      return;
    }
    const previous = tracks.find(
      (track) => track.index === lastSelectedTrackRef.current && !track.bitmap,
    );
    const next = previous ?? tracks.find((track) => !track.bitmap);
    if (next) selectSubtitle(next.index);
  }, [selectSubtitle, selectedId, tracks]);

  return {
    selectedId,
    selectSubtitle,
    activeCues,
    loading,
    error,
    style,
    updateStyle,
    resetStyle,
    delay,
    setDelay,
    hasTextTracks,
    hasBitmapTracks,
    toggleFirstTrack,
  };
}
