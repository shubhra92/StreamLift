"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  AlertCircle,
  Download,
  Loader2,
  Maximize,
  Minimize,
  Music,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type {
  WorkerAudioTrack,
  WorkerChapter,
  WorkerPlaybackUrls,
  WorkerSubtitleTrack,
} from "@/app/lib/workerConnection";
import type { WatchFile } from "../types";
import { AudioMenu } from "./AudioMenu";
import { ChapterMenu } from "./ChapterMenu";
import { SettingsMenu } from "./SettingsMenu";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { SubtitleMenu } from "./SubtitleMenu";
import { SeekBar } from "./SeekBar";
import { formatBitrate, formatTime } from "./format";
import {
  audioLabel,
  languageName,
  subtitleLabel,
  type PlaybackSource,
  type PlayerAudioOption,
  type PlayerMenu,
  type PlayerStats,
  type PlayerStatus,
  type SourceKind,
} from "./types";
import {
  clearResume,
  loadAudioPreference,
  loadPlayerPrefs,
  loadResume,
  saveAudioPreference,
  savePlayerPrefs,
  saveResume,
} from "./storage";
import {
  hexToRgba,
  subtitleFontFamily,
  subtitleTextShadow,
} from "./subtitles";
import { useMediaEngine } from "./useMediaEngine";
import { useSubtitles } from "./useSubtitles";

interface Props {
  workerId: string;
  workerName?: string;
  file: WatchFile;
  source: PlaybackSource | null;
  urls: WorkerPlaybackUrls | null;
  status: PlayerStatus;
  progress: number;
  speed: number | null;
  sourceHeight: number | null;
  targetHeight: number | null;
  errorMessage: string | null;
  downloading: boolean;
  downloadError: string | null;
  onDismissDownloadError: () => void;
  audioTracks: WorkerAudioTrack[];
  subtitleTracks: WorkerSubtitleTrack[];
  chapters: WorkerChapter[];
  onDownload: () => void;
  onClose: () => void;
  onRetry: () => void;
  onSourceError: (kind: SourceKind) => void;
  onPlaybackError: (message: string) => void;
  onReady: () => void;
  onNextFile?: () => void;
  onPreviousFile?: () => void;
  hasNext?: boolean;
  hasPrevious?: boolean;
}

interface BufferedRange {
  start: number;
  end: number;
}

function readBuffered(media: HTMLMediaElement): BufferedRange[] {
  const ranges: BufferedRange[] = [];
  try {
    for (let index = 0; index < media.buffered.length; index += 1) {
      const start = media.buffered.start(index);
      const end = media.buffered.end(index);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        ranges.push({ start, end });
      }
    }
  } catch {
    /* buffered ranges may be unavailable during teardown */
  }
  return ranges;
}

function bufferAhead(media: HTMLMediaElement): number {
  try {
    const time = media.currentTime;
    for (let index = 0; index < media.buffered.length; index += 1) {
      if (time >= media.buffered.start(index) && time <= media.buffered.end(index)) {
        return Math.max(0, media.buffered.end(index) - time);
      }
    }
  } catch {
    /* ignore */
  }
  return 0;
}

const VIDEO_STALL_THRESHOLD_MS = 450;
const VIDEO_WATCH_INTERVAL_MS = 100;
const VIDEO_GUARD_MIN_BUFFER_S = 0.75;
const VIDEO_GUARD_BASE_DELAY_MS = 800;
const VIDEO_GUARD_MAX_DELAY_MS = 4000;

interface FrameQuality {
  totalVideoFrames: number;
  droppedVideoFrames: number;
}

interface FrameCallbackMedia extends HTMLVideoElement {
  webkitDecodedFrameCount?: number;
  webkitDroppedFrameCount?: number;
}

function readFrameQuality(media: HTMLMediaElement): FrameQuality | null {
  if (!(media instanceof HTMLVideoElement)) return null;
  try {
    if (typeof media.getVideoPlaybackQuality === "function") {
      const quality = media.getVideoPlaybackQuality();
      return {
        totalVideoFrames: quality.totalVideoFrames ?? 0,
        droppedVideoFrames: quality.droppedVideoFrames ?? 0,
      };
    }
    const legacy = media as FrameCallbackMedia;
    if (typeof legacy.webkitDecodedFrameCount === "number") {
      return {
        totalVideoFrames: legacy.webkitDecodedFrameCount,
        droppedVideoFrames: legacy.webkitDroppedFrameCount ?? 0,
      };
    }
  } catch {
    /* frame counters are optional diagnostics */
  }
  return null;
}

const CONTROL_BUTTON =
  "flex h-9 w-9 items-center justify-center rounded-md text-white/85 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40";

export function MediaPlayer({
  workerId,
  workerName,
  file,
  source,
  urls,
  status,
  progress,
  speed,
  sourceHeight,
  targetHeight,
  errorMessage,
  downloading,
  downloadError,
  onDismissDownloadError,
  audioTracks,
  subtitleTracks,
  chapters,
  onDownload,
  onClose,
  onRetry,
  onSourceError,
  onPlaybackError,
  onReady,
  onNextFile,
  onPreviousFile,
  hasNext,
  hasPrevious,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const lastSavedRef = useRef(0);
  const lastPositionRef = useRef(0);
  const endedRef = useRef(false);
  const resumeAppliedRef = useRef("");
  const surfaceClickRef = useRef<number | null>(null);
  const lastVideoFrameAtRef = useRef(0);
  const frameCountTotalRef = useRef(0);
  const videoFrameCallbackRef = useRef<number | null>(null);
  const guardPausedRef = useRef(false);
  const guardWakeAtRef = useRef(0);
  const guardStartedAtRef = useRef(0);
  const guardStallCountRef = useRef(0);
  const guardLastStableAtRef = useRef(0);
  const freezeCountRef = useRef(0);
  const lastFreezeMsRef = useRef(0);

  const isVideo = file.kind === "video";
  const fileKey = `${workerId}:${file.downloadId}:${file.index}`;

  const [initialPrefs] = useState(loadPlayerPrefs);
  const [volume, setVolume] = useState(initialPrefs.volume);
  const [muted, setMuted] = useState(initialPrefs.muted);
  const [rate, setRate] = useState(initialPrefs.rate);
  const [loop, setLoop] = useState(initialPrefs.loop);
  const [autoplayNext, setAutoplayNext] = useState(initialPrefs.autoplayNext);
  const [controlBackgroundOpacity, setControlBackgroundOpacity] = useState(
    initialPrefs.controlBackgroundOpacity,
  );
  const lastAudibleVolumeRef = useRef(initialPrefs.volume > 0 ? initialPrefs.volume : 1);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState<BufferedRange[]>([]);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);
  const [openMenu, setOpenMenu] = useState<PlayerMenu>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [resumeToast, setResumeToast] = useState<number | null>(null);

  const engine = useMediaEngine({
    mediaRef,
    source,
    fileKey,
    onReady,
    onSourceError,
    onPlaybackError,
  });
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const onNextFileRef = useRef(onNextFile);
  onNextFileRef.current = onNextFile;

  const subtitles = useSubtitles({
    mediaRef,
    tracks: subtitleTracks,
    urls,
    fileKey,
  });

  const audioOptions = useMemo<PlayerAudioOption[]>(() => {
    let options: PlayerAudioOption[];
    if (engine.audioTracks.length > 0) {
      options = engine.audioTracks.map((track) => {
        const meta = audioTracks.find((candidate) => candidate.index === track.id);
        const label =
          meta?.title?.trim() ||
          (meta?.language ? languageName(meta.language) : "") ||
          track.label ||
          `Track ${track.id + 1}`;
        return {
          id: track.id,
          label,
          language: track.language ?? meta?.language ?? null,
          codec: meta?.codec ?? null,
          channels: track.channels ?? meta?.channels ?? null,
          default: track.default,
        };
      });
    } else {
      options = audioTracks.map((track) => ({
        id: track.index,
        label: audioLabel(track, track.index),
        language: track.language,
        codec: track.codec,
        channels: track.channels,
        default: track.default,
      }));
    }
    // Sources often carry several untitled tracks in the same language.
    // Number the duplicates so the menu is unambiguous.
    const seen = new Map<string, number>();
    return options.map((option) => {
      const count = seen.get(option.label) ?? 0;
      seen.set(option.label, count + 1);
      return count === 0
        ? option
        : { ...option, label: `${option.label} (${count + 1})` };
    });
  }, [audioTracks, engine.audioTracks]);

  const selectedAudioId =
    engine.selectedAudio ??
    (audioOptions.length === 1
      ? audioOptions[0].id
      : (audioOptions.find((track) => track.default)?.id ?? null));

  const subtitleOptions = useMemo(() => {
    const options = subtitleTracks.map((track) => ({
      ...track,
      label: subtitleLabel(track, track.index),
    }));
    const seen = new Map<string, number>();
    return options.map((option) => {
      const count = seen.get(option.label) ?? 0;
      seen.set(option.label, count + 1);
      return count === 0
        ? option
        : { ...option, label: `${option.label} (${count + 1})` };
    });
  }, [subtitleTracks]);

  const activeChapter = useMemo(
    () =>
      chapters.find(
        (chapter) => currentTime >= chapter.start && currentTime < chapter.end,
      ) ?? null,
    [chapters, currentTime],
  );

  const togglePlay = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    if (guardPausedRef.current) {
      // The watchdog paused the media to stop audio while video was frozen.
      // Treat the user's pause/play toggle as "leave it paused" and clear the
      // automatic-resume intent; a second click will start playback again.
      guardPausedRef.current = false;
      guardWakeAtRef.current = 0;
      const stalled = performance.now() - guardStartedAtRef.current;
      if (stalled > 0) lastFreezeMsRef.current = Math.round(stalled);
      setWaiting(false);
      setPlaying(false);
      return;
    }
    if (media.paused || media.ended) {
      void media.play().catch(() => undefined);
    } else {
      media.pause();
    }
  }, []);

  const seekTo = useCallback((time: number) => {
    const media = mediaRef.current;
    if (!media) return;
    const max = Number.isFinite(media.duration) ? media.duration : time;
    const target = Math.max(0, Math.min(max, time));
    try {
      media.currentTime = target;
      lastPositionRef.current = target;
    } catch {
      /* seeking before metadata is ready */
    }
    setCurrentTime(target);
  }, []);

  const seekBy = useCallback(
    (delta: number) => {
      const media = mediaRef.current;
      if (!media) return;
      seekTo(media.currentTime + delta);
    },
    [seekTo],
  );

  const changeVolume = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(1, value));
    setVolume(clamped);
    if (clamped > 0) {
      lastAudibleVolumeRef.current = clamped;
      setMuted(false);
    }
  }, []);

  const toggleMute = useCallback(() => {
    if (muted || volume === 0) {
      setMuted(false);
      if (volume === 0) {
        setVolume(lastAudibleVolumeRef.current || 0.5);
      }
    } else {
      lastAudibleVolumeRef.current = volume;
      setMuted(true);
    }
  }, [muted, volume]);

  const handleSelectAudio = useCallback(
    (id: number) => {
      engine.selectAudio(id);
      saveAudioPreference(fileKey, id);
      setOpenMenu(null);
    },
    [engine, fileKey],
  );

  const cycleAudio = useCallback(() => {
    if (!engine.switchableAudio || audioOptions.length < 2) return;
    const currentIndex = audioOptions.findIndex((track) => track.id === selectedAudioId);
    const next = audioOptions[(currentIndex + 1) % audioOptions.length];
    if (!next) return;
    engine.selectAudio(next.id);
    saveAudioPreference(fileKey, next.id);
  }, [audioOptions, engine, fileKey, selectedAudioId]);

  const changeRate = useCallback((value: number) => {
    setRate(Math.max(0.25, Math.min(3, value)));
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    const media = mediaRef.current;
    const documentFullscreen =
      Boolean(document.fullscreenElement) ||
      Boolean((document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement);

    if (!documentFullscreen) {
      const enterNativeFullscreen = () => {
        if (media && "webkitEnterFullscreen" in media) {
          (media as HTMLMediaElement & { webkitEnterFullscreen?: () => void })
            .webkitEnterFullscreen?.();
        }
      };
      if (container?.requestFullscreen) {
        // iPhone Safari exposes requestFullscreen but rejects it for non-video
        // elements. Fall back to the native video fullscreen in that case.
        void container.requestFullscreen().catch(enterNativeFullscreen);
      } else {
        enterNativeFullscreen();
      }
    } else if (document.exitFullscreen) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      (document as Document & { webkitExitFullscreen?: () => void }).webkitExitFullscreen?.();
    }
  }, []);

  const togglePip = useCallback(async () => {
    const media = mediaRef.current;
    if (!media || !("pictureInPictureEnabled" in document) || !document.pictureInPictureEnabled) {
      return;
    }
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        const pipMedia = media as HTMLMediaElement & {
          requestPictureInPicture?: () => Promise<PictureInPictureWindow>;
        };
        await pipMedia.requestPictureInPicture?.();
      }
    } catch {
      /* PiP can be rejected without a user gesture */
    }
  }, []);

  const startOver = useCallback(() => {
    seekTo(0);
    clearResume(fileKey);
    setResumeToast(null);
  }, [fileKey, seekTo]);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (!playing || openMenu !== null || shortcutsOpen) return;
    hideTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      hideTimerRef.current = null;
    }, 3200);
  }, [openMenu, playing, shortcutsOpen]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  // ── Element properties ────────────────────────────────────────────────────
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    media.volume = volume;
    media.muted = muted;
  }, [volume, muted, isVideo, fileKey]);

  useEffect(() => {
    const media = mediaRef.current;
    if (media) media.playbackRate = rate;
  }, [rate, isVideo, fileKey]);

  useEffect(() => {
    const media = mediaRef.current;
    if (media) media.loop = loop;
  }, [loop, isVideo, fileKey]);

  useEffect(() => {
    savePlayerPrefs({
      volume,
      muted,
      rate,
      loop,
      autoplayNext,
      controlBackgroundOpacity,
    });
  }, [volume, muted, rate, loop, autoplayNext, controlBackgroundOpacity]);

  // ── Media element events ──────────────────────────────────────────────────
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    let disposed = false;
    const video =
      isVideo && media instanceof HTMLVideoElement
        ? (media as FrameCallbackMedia)
        : null;
    const prefersFrameCallback = Boolean(
      video && typeof video.requestVideoFrameCallback === "function",
    );
    const canDetectFrames = Boolean(
      video &&
        (prefersFrameCallback ||
          typeof video.getVideoPlaybackQuality === "function" ||
          typeof video.webkitDecodedFrameCount === "number"),
    );
    let watchdogTimer: number | null = null;

    const markVideoFrame = () => {
      lastVideoFrameAtRef.current = performance.now();
    };

    const cancelFrameCallback = () => {
      const handle = videoFrameCallbackRef.current;
      videoFrameCallbackRef.current = null;
      if (handle !== null) {
        try {
          video?.cancelVideoFrameCallback?.(handle);
        } catch {
          /* already cancelled */
        }
      }
    };

    const armFrameCallback = () => {
      if (
        !video ||
        disposed ||
        media.paused ||
        media.ended ||
        videoFrameCallbackRef.current !== null ||
        typeof video.requestVideoFrameCallback !== "function"
      ) {
        return;
      }
      videoFrameCallbackRef.current = video.requestVideoFrameCallback(() => {
        videoFrameCallbackRef.current = null;
        if (disposed || media.paused) return;
        markVideoFrame();
        armFrameCallback();
      });
    };

    const refreshFrameClock = () => {
      const quality = readFrameQuality(video ?? media);
      if (!quality) return;
      if (quality.totalVideoFrames > frameCountTotalRef.current) {
        frameCountTotalRef.current = quality.totalVideoFrames;
        // rVFC reports frames that were actually presented. Decoded-frame
        // counters can keep rising when every frame is dropped, so only use
        // them as the clock when rVFC is unavailable.
        if (!prefersFrameCallback) markVideoFrame();
      }
    };

    const enterGuard = (now: number) => {
      if (
        disposed ||
        !video ||
        guardPausedRef.current ||
        media.paused ||
        media.seeking ||
        media.ended ||
        !canDetectFrames ||
        !video.videoWidth
      ) {
        return;
      }
      const lastFrame = lastVideoFrameAtRef.current;
      if (lastFrame <= 0 || now - lastFrame < VIDEO_STALL_THRESHOLD_MS) {
        return;
      }

      guardPausedRef.current = true;
      // Include the time since the last presented frame in the reported
      // freeze duration, not just the watchdog's reaction time.
      guardStartedAtRef.current = lastFrame;
      guardStallCountRef.current += 1;
      freezeCountRef.current += 1;
      guardWakeAtRef.current =
        now +
        Math.min(
          VIDEO_GUARD_MAX_DELAY_MS,
          VIDEO_GUARD_BASE_DELAY_MS +
            (guardStallCountRef.current - 1) * 500,
        );
      cancelFrameCallback();
      setWaiting(true);
      try {
        // Audio and video are separate HLS renditions. Pausing here stops the
        // audio at the same instant the video froze instead of letting it run
        // ahead for several seconds.
        media.pause();
      } catch {
        /* media can be torn down between ticks */
      }
    };

    const resumeGuard = (now: number) => {
      if (
        disposed ||
        !guardPausedRef.current ||
        media.ended ||
        media.seeking ||
        now < guardWakeAtRef.current
      ) {
        return;
      }
      if (media.readyState < 2) return;

      const ahead = engineRef.current.videoBufferAhead();
      if (ahead < VIDEO_GUARD_MIN_BUFFER_S) return;

      guardPausedRef.current = false;
      guardLastStableAtRef.current = now;
      lastFreezeMsRef.current = Math.round(now - guardStartedAtRef.current);
      lastVideoFrameAtRef.current = now;
      const quality = readFrameQuality(video ?? media);
      frameCountTotalRef.current = quality?.totalVideoFrames ?? 0;
      armFrameCallback();
      void media.play().catch(() => {
        if (disposed) return;
        guardPausedRef.current = true;
        guardWakeAtRef.current = performance.now() + 1000;
        setWaiting(true);
      });
    };

    const watchdogTick = () => {
      if (disposed) return;
      const now = performance.now();
      if (video && !media.seeking && !media.ended) {
        const watching =
          document.visibilityState === "visible" ||
          document.pictureInPictureElement === video;
        if (watching) {
          refreshFrameClock();
          if (guardPausedRef.current) {
            resumeGuard(now);
          } else if (!media.paused && canDetectFrames) {
            if (lastVideoFrameAtRef.current <= 0) {
              lastVideoFrameAtRef.current = now;
            }
            if (now - guardLastStableAtRef.current > 10000) {
              guardStallCountRef.current = 0;
            }
            if (now - lastVideoFrameAtRef.current >= VIDEO_STALL_THRESHOLD_MS) {
              enterGuard(now);
            }
          }
        } else {
          // Background tabs throttle both rVFC and media events. Don't mistake
          // that throttling for a decoder stall.
          lastVideoFrameAtRef.current = now;
        }
      }
      watchdogTimer = window.setTimeout(
        watchdogTick,
        VIDEO_WATCH_INTERVAL_MS,
      );
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        lastVideoFrameAtRef.current = performance.now();
      }
    };

    const syncBuffered = () => {
      if (!disposed) setBuffered(readBuffered(media));
    };

    const onLoadedMetadata = () => {
      if (disposed) return;
      const nextDuration =
        Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
      setDuration(nextDuration);
      syncBuffered();
      // HLS can fire loadedmetadata before it knows the final duration. Wait
      // for a durationchange with a real value before consuming the resume.
      if (nextDuration <= 0) return;
      if (resumeAppliedRef.current !== fileKey) {
        resumeAppliedRef.current = fileKey;
        const saved = loadResume(fileKey);
        if (saved && nextDuration > 0 && saved > 5 && saved < nextDuration - 10) {
          try {
            media.currentTime = saved;
            setCurrentTime(saved);
            setResumeToast(saved);
            lastPositionRef.current = saved;
          } catch {
            /* metadata race */
          }
        } else {
          lastPositionRef.current = 0;
        }
      }
    };

    const onTimeUpdate = () => {
      if (disposed) return;
      lastPositionRef.current = media.currentTime;
      setCurrentTime(media.currentTime);
      const now = Date.now();
      if (!media.paused && now - lastSavedRef.current > 5000) {
        lastSavedRef.current = now;
        saveResume(fileKey, media.currentTime);
      }
    };

    const onSeeked = () => {
      if (disposed) return;
      lastPositionRef.current = media.currentTime;
      setCurrentTime(media.currentTime);
      syncBuffered();
      guardWakeAtRef.current = 0;
      // Seeking keeps the media element busy without presenting frames. Start
      // the watchdog clock fresh so a long seek does not look like a stall.
      lastVideoFrameAtRef.current = performance.now();
      const quality = readFrameQuality(video ?? media);
      frameCountTotalRef.current = quality?.totalVideoFrames ?? 0;
      if (guardPausedRef.current) {
        // A seek is a deliberate user action; resume automatically once the
        // new position has a frame rather than leaving the player stuck on the
        // watchdog's loading spinner.
        guardPausedRef.current = false;
        lastFreezeMsRef.current = Math.round(
          performance.now() - guardStartedAtRef.current,
        );
        setWaiting(false);
        void media.play().catch(() => undefined);
      }
    };

    const onPlay = () => {
      if (disposed) return;
      if (guardPausedRef.current) {
        // A late autoplay request (for example hls.js after MANIFEST_PARSED)
        // must not start audio while the video watchdog is holding playback.
        try {
          media.pause();
        } catch {
          /* media may be tearing down */
        }
        setWaiting(true);
        return;
      }
      endedRef.current = false;
      guardWakeAtRef.current = 0;
      if (performance.now() - guardLastStableAtRef.current > 10000) {
        guardStallCountRef.current = 0;
      }
      const quality = readFrameQuality(video ?? media);
      frameCountTotalRef.current = quality?.totalVideoFrames ?? 0;
      lastVideoFrameAtRef.current = performance.now();
      armFrameCallback();
      setPlaying(true);
      setWaiting(false);
    };

    const onPause = () => {
      if (disposed) return;
      if (guardPausedRef.current) {
        // This pause came from the video watchdog; keep the UI in its loading
        // state so the automatic resume is visible.
        setWaiting(true);
        return;
      }
      setPlaying(false);
      setWaiting(false);
      guardWakeAtRef.current = 0;
      cancelFrameCallback();
      if (media.currentTime > 1 && !media.ended) {
        lastPositionRef.current = media.currentTime;
        saveResume(fileKey, media.currentTime);
      }
    };

    const onWaiting = () => {
      if (!disposed && (!media.paused || guardPausedRef.current)) {
        setWaiting(true);
      }
    };

    const onPlaying = () => {
      if (disposed) return;
      if (guardPausedRef.current) {
        try {
          media.pause();
        } catch {
          /* media may be tearing down */
        }
        setWaiting(true);
        return;
      }
      lastVideoFrameAtRef.current = performance.now();
      armFrameCallback();
      setWaiting(false);
    };

    const onCanPlay = () => {
      if (!disposed && !guardPausedRef.current) setWaiting(false);
    };

    const onEnded = () => {
      if (disposed) return;
      guardPausedRef.current = false;
      guardWakeAtRef.current = 0;
      cancelFrameCallback();
      endedRef.current = true;
      lastPositionRef.current = 0;
      setPlaying(false);
      setWaiting(false);
      clearResume(fileKey);
      if (loop) {
        media.currentTime = 0;
        void media.play().catch(() => undefined);
      } else if (autoplayNext && onNextFileRef.current) {
        onNextFileRef.current();
      } else {
        setControlsVisible(true);
      }
    };

    const onVolumeChange = () => {
      if (disposed) return;
      setVolume(media.volume);
      setMuted(media.muted);
    };

    const onRateChange = () => {
      if (!disposed) setRate(media.playbackRate);
    };

    const onEnterPip = () => setPipActive(true);
    const onLeavePip = () => setPipActive(false);

    media.addEventListener("loadedmetadata", onLoadedMetadata);
    media.addEventListener("durationchange", onLoadedMetadata);
    media.addEventListener("timeupdate", onTimeUpdate);
    media.addEventListener("progress", syncBuffered);
    media.addEventListener("seeking", syncBuffered);
    media.addEventListener("seeked", onSeeked);
    media.addEventListener("play", onPlay);
    media.addEventListener("pause", onPause);
    media.addEventListener("waiting", onWaiting);
    media.addEventListener("playing", onPlaying);
    media.addEventListener("canplay", onCanPlay);
    media.addEventListener("ended", onEnded);
    media.addEventListener("volumechange", onVolumeChange);
    media.addEventListener("ratechange", onRateChange);
    media.addEventListener("enterpictureinpicture", onEnterPip);
    media.addEventListener("leavepictureinpicture", onLeavePip);
    document.addEventListener("visibilitychange", onVisibilityChange);
    // The effect can re-run while a previous playback is still active (for
    // example when a parent callback identity changes). In that case no new
    // "play" event will fire, so prime the frame clock here as well.
    if (!media.paused && !media.ended) {
      lastVideoFrameAtRef.current = performance.now();
      const quality = readFrameQuality(video ?? media);
      frameCountTotalRef.current = quality?.totalVideoFrames ?? 0;
      armFrameCallback();
    }
    watchdogTick();

    return () => {
      disposed = true;
      if (watchdogTimer !== null) {
        window.clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      cancelFrameCallback();
      // Keep the guard and freeze clock across effect re-runs (for example a
      // loop/autoplay preference change). File and source changes reset these
      // explicitly in their own effects.
      media.removeEventListener("loadedmetadata", onLoadedMetadata);
      media.removeEventListener("durationchange", onLoadedMetadata);
      media.removeEventListener("timeupdate", onTimeUpdate);
      media.removeEventListener("progress", syncBuffered);
      media.removeEventListener("seeking", syncBuffered);
      media.removeEventListener("seeked", onSeeked);
      media.removeEventListener("play", onPlay);
      media.removeEventListener("pause", onPause);
      media.removeEventListener("waiting", onWaiting);
      media.removeEventListener("playing", onPlaying);
      media.removeEventListener("canplay", onCanPlay);
      media.removeEventListener("ended", onEnded);
      media.removeEventListener("volumechange", onVolumeChange);
      media.removeEventListener("ratechange", onRateChange);
      media.removeEventListener("enterpictureinpicture", onEnterPip);
      media.removeEventListener("leavepictureinpicture", onLeavePip);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [autoplayNext, fileKey, isVideo, loop]);

  // Reset the surface when the selected file changes.
  useEffect(() => {
    setPlaying(false);
    setWaiting(false);
    setCurrentTime(0);
    setDuration(0);
    setBuffered([]);
    setOpenMenu(null);
    setStatsOpen(false);
    setShortcutsOpen(false);
    setResumeToast(null);
    setControlsVisible(true);
    resumeAppliedRef.current = "";
    lastSavedRef.current = 0;
    lastPositionRef.current = 0;
    endedRef.current = false;
    guardPausedRef.current = false;
    guardWakeAtRef.current = 0;
    guardStartedAtRef.current = 0;
    guardStallCountRef.current = 0;
    guardLastStableAtRef.current = 0;
    lastVideoFrameAtRef.current = 0;
    frameCountTotalRef.current = 0;
    freezeCountRef.current = 0;
    lastFreezeMsRef.current = 0;
  }, [fileKey]);

  // Persist the last position when the dialog closes or the file changes.
  // Use the tracked position: engine teardown may reset currentTime first.
  useEffect(
    () => () => {
      if (!endedRef.current && lastPositionRef.current > 1) {
        saveResume(fileKey, lastPositionRef.current);
      }
    },
    [fileKey],
  );

  const sourceKey = source ? `${source.kind}:${source.url}` : "";

  // A retry (or an automatic fallback) tears down the engine and gives the
  // media element a fresh timeline. Save where the viewer was and let the
  // resume logic run again for the new source.
  useEffect(() => {
    if (!sourceKey) return;
    if (!endedRef.current && lastPositionRef.current > 1) {
      saveResume(fileKey, lastPositionRef.current);
    }
    resumeAppliedRef.current = "";
    guardPausedRef.current = false;
    guardWakeAtRef.current = 0;
    guardStartedAtRef.current = 0;
    guardStallCountRef.current = 0;
    guardLastStableAtRef.current = 0;
    lastVideoFrameAtRef.current = 0;
    frameCountTotalRef.current = 0;
    freezeCountRef.current = 0;
    lastFreezeMsRef.current = 0;
  }, [fileKey, sourceKey]);

  // Restore the preferred audio track whenever the engine exposes a new track
  // list. Re-applying (rather than once per file) also survives HLS retries,
  // which reset the rendition to the manifest default.
  useEffect(() => {
    if (engine.audioTracks.length === 0) return;
    const saved = loadAudioPreference(fileKey);
    if (
      saved !== undefined &&
      saved >= 0 &&
      saved < engine.audioTracks.length &&
      engine.selectedAudio !== saved
    ) {
      engine.selectAudio(saved);
    }
  }, [engine.audioTracks.length, engine.selectedAudio, engine.selectAudio, fileKey]);

  // Resume toast lifetime.
  useEffect(() => {
    if (resumeToast === null) return;
    const timer = window.setTimeout(() => setResumeToast(null), 10000);
    return () => window.clearTimeout(timer);
  }, [resumeToast]);

  // Fullscreen + PiP support.
  useEffect(() => {
    const onFullscreenChange = () => {
      setFullscreen(
        Boolean(document.fullscreenElement) ||
          Boolean((document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement),
      );
      setOpenMenu(null);
    };
    onFullscreenChange();
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    };
  }, []);

  useEffect(() => {
    setPipSupported(
      typeof document !== "undefined" &&
        "pictureInPictureEnabled" in document &&
        Boolean(document.pictureInPictureEnabled),
    );
  }, []);

  // Auto-hide controls.
  useEffect(() => {
    if (!playing || openMenu !== null || shortcutsOpen) {
      setControlsVisible(true);
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      return;
    }
    scheduleHide();
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [openMenu, playing, scheduleHide, shortcutsOpen]);

  // Playback statistics.
  useEffect(() => {
    if (!statsOpen) {
      setStats(null);
      return;
    }
    const update = () => {
      const media = mediaRef.current;
      if (!media) return;
      const quality = readFrameQuality(media);
      const level =
        engine.currentLevel >= 0 ? engine.levels[engine.currentLevel] : undefined;
      const label =
        engine.currentLevel >= 0
          ? `${engine.autoLevel ? "Auto · " : ""}${
              level?.name ||
              (level?.height ? `${level.height}p` : `Level ${engine.currentLevel + 1}`)
            }`
          : engine.levels.length === 1
            ? engine.levels[0]?.name ||
              (engine.levels[0]?.height
                ? `${engine.levels[0].height}p`
                : "Single quality")
            : "Source";
      setStats({
        width: media instanceof HTMLVideoElement ? media.videoWidth : 0,
        height: media instanceof HTMLVideoElement ? media.videoHeight : 0,
        bufferAhead: bufferAhead(media),
        videoBufferAhead: engine.videoBufferAhead(),
        droppedFrames: quality?.droppedVideoFrames ?? 0,
        totalFrames: quality?.totalVideoFrames ?? 0,
        freezeCount: freezeCountRef.current,
        lastFreezeMs: guardPausedRef.current
          ? Math.round(performance.now() - guardStartedAtRef.current)
          : lastFreezeMsRef.current,
        bandwidth: engine.bandwidthEstimate,
        level: label,
        fps: null,
      });
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [
    engine.autoLevel,
    engine.bandwidthEstimate,
    engine.currentLevel,
    engine.engineLabel,
    engine.levels,
    engine.videoBufferAhead,
    statsOpen,
  ]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  const actionsRef = useRef({
    togglePlay,
    seekBy,
    seekTo,
    changeVolume,
    toggleMute,
    toggleFullscreen,
    togglePip,
    cycleAudio,
    toggleSubtitles: subtitles.toggleFirstTrack,
    changeRate,
    setRate,
    setOpenMenu,
    setShortcutsOpen,
    setStatsOpen,
    openMenu,
    shortcutsOpen,
    fullscreen,
    statsOpen,
    duration,
    playing,
    onNextFile,
    onPreviousFile,
    hasNext,
    hasPrevious,
    rate,
    volume,
  });
  actionsRef.current = {
    togglePlay,
    seekBy,
    seekTo,
    changeVolume,
    toggleMute,
    toggleFullscreen,
    togglePip,
    cycleAudio,
    toggleSubtitles: subtitles.toggleFirstTrack,
    changeRate,
    setRate,
    setOpenMenu,
    setShortcutsOpen,
    setStatsOpen,
    openMenu,
    shortcutsOpen,
    fullscreen,
    statsOpen,
    duration,
    playing,
    onNextFile,
    onPreviousFile,
    hasNext,
    hasPrevious,
    rate,
    volume,
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;

      const actions = actionsRef.current;
      const key = event.key;

      const handled = () => event.preventDefault();

      // Escape must work even when focus is inside a menu input (color/range):
      // close the overlay or menu without letting the dialog swallow the key.
      if (key === "Escape") {
        if (actions.shortcutsOpen) {
          actions.setShortcutsOpen(false);
          handled();
          event.stopPropagation();
          return;
        }
        if (actions.openMenu !== null) {
          actions.setOpenMenu(null);
          handled();
          event.stopPropagation();
          return;
        }
        if (actions.statsOpen) {
          actions.setStatsOpen(false);
          handled();
          event.stopPropagation();
          return;
        }
        return;
      }

      if (
        target &&
        (target.isContentEditable ||
          target.closest("input, textarea, select, [role='slider']"))
      ) {
        return;
      }
      if (target?.closest("button") && (key === " " || key === "Enter")) {
        return;
      }

      if (key === " " || key.toLowerCase() === "k") {
        handled();
        actions.togglePlay();
      } else if (key === "ArrowLeft") {
        handled();
        actions.seekBy(-5);
      } else if (key === "ArrowRight") {
        handled();
        actions.seekBy(5);
      } else if (key === "ArrowUp") {
        handled();
        actions.changeVolume(actions.volume + 0.05);
      } else if (key === "ArrowDown") {
        handled();
        actions.changeVolume(actions.volume - 0.05);
      } else if (key.toLowerCase() === "j") {
        handled();
        actions.seekBy(-10);
      } else if (key.toLowerCase() === "l") {
        handled();
        actions.seekBy(10);
      } else if (key.toLowerCase() === "m") {
        handled();
        actions.toggleMute();
      } else if (key.toLowerCase() === "f") {
        handled();
        actions.toggleFullscreen();
      } else if (key.toLowerCase() === "p") {
        handled();
        void actions.togglePip();
      } else if (key.toLowerCase() === "c") {
        handled();
        actions.toggleSubtitles();
      } else if (key.toLowerCase() === "a") {
        handled();
        actions.cycleAudio();
      } else if (key.toLowerCase() === "i") {
        handled();
        actions.setStatsOpen(!actions.statsOpen);
      } else if (key === "?") {
        handled();
        actions.setShortcutsOpen(!actions.shortcutsOpen);
      } else if (key === "<" || key === ",") {
        handled();
        if (key === ",") actions.seekBy(-1 / 30);
        else actions.setRate(Math.max(0.25, actions.rate - 0.25));
      } else if (key === ">" || key === ".") {
        handled();
        if (key === ".") actions.seekBy(1 / 30);
        else actions.setRate(Math.min(3, actions.rate + 0.25));
      } else if (key.toLowerCase() === "n" && actions.hasNext && actions.onNextFile) {
        handled();
        actions.onNextFile();
      } else if (key.toLowerCase() === "b" && actions.hasPrevious && actions.onPreviousFile) {
        handled();
        actions.onPreviousFile();
      } else if (key === "Home") {
        handled();
        actions.seekTo(0);
      } else if (key === "End") {
        handled();
        actions.seekTo(actions.duration);
      } else if (/^[0-9]$/.test(key) && actions.duration > 0) {
        handled();
        actions.seekTo((Number(key) / 10) * actions.duration);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // ── Media Session (lock-screen / OS controls) ─────────────────────────────
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    try {
      if ("MediaMetadata" in window) {
        session.metadata = new MediaMetadata({
          title: file.name,
          artist: workerName || "StreamLift",
          album: "StreamLift",
        });
      }
    } catch {
      /* metadata is optional */
    }

    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => void mediaRef.current?.play().catch(() => undefined)],
      ["pause", () => mediaRef.current?.pause()],
      ["seekbackward", (details) => seekBy(-(details.seekOffset ?? 10))],
      ["seekforward", (details) => seekBy(details.seekOffset ?? 10)],
      [
        "seekto",
        (details) => {
          if (typeof details.seekTime === "number") seekTo(details.seekTime);
        },
      ],
      ["previoustrack", () => onPreviousFile?.()],
      ["nexttrack", () => onNextFile?.()],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        /* unsupported action */
      }
    }

    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          /* ignore */
        }
      }
    };
  }, [file.name, onNextFile, onPreviousFile, seekBy, seekTo, workerName]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }, [playing]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    if (typeof session.setPositionState !== "function" || duration <= 0) return;
    try {
      session.setPositionState({
        duration,
        playbackRate: rate,
        position: Math.max(0, Math.min(duration, currentTime)),
      });
    } catch {
      /* optional API */
    }
  }, [currentTime, duration, rate]);

  // ── Interactions ──────────────────────────────────────────────────────────
  const handleSurfaceClick = useCallback(() => {
    showControls();
    if (surfaceClickRef.current !== null) {
      window.clearTimeout(surfaceClickRef.current);
      surfaceClickRef.current = null;
      toggleFullscreen();
      return;
    }
    surfaceClickRef.current = window.setTimeout(() => {
      surfaceClickRef.current = null;
      togglePlay();
    }, 220);
  }, [showControls, toggleFullscreen, togglePlay]);

  const subtitleCueStyle = useMemo<CSSProperties>(
    () => ({
      color: subtitles.style.color,
      backgroundColor: hexToRgba(
        subtitles.style.background,
        subtitles.style.backgroundOpacity,
      ),
      fontFamily: subtitleFontFamily(subtitles.style),
      fontSize: `clamp(${(15 * subtitles.style.scale).toFixed(1)}px, ${(
        2.4 * subtitles.style.scale
      ).toFixed(2)}vw, ${(30 * subtitles.style.scale).toFixed(1)}px)`,
      fontWeight: subtitles.style.weight,
      lineHeight: subtitles.style.lineHeight,
      textAlign: subtitles.style.align,
      textShadow: subtitleTextShadow(subtitles.style),
      padding: "0.12em 0.45em",
      borderRadius: "0.22em",
      whiteSpace: "pre-line",
      maxWidth: "92%",
      wordBreak: "break-word",
    }),
    [subtitles.style],
  );

  const hasNextValue = Boolean(hasNext && onNextFile);
  const hasPreviousValue = Boolean(hasPrevious && onPreviousFile);
  const showControlsClass =
    controlsVisible || !playing || openMenu !== null || shortcutsOpen;
  const topBarBackground = `linear-gradient(to bottom, rgba(0, 0, 0, ${
    0.9 * controlBackgroundOpacity
  }), rgba(0, 0, 0, ${
    0.45 * controlBackgroundOpacity
  }), rgba(0, 0, 0, 0))`;
  const bottomBarBackground = `linear-gradient(to top, rgba(0, 0, 0, ${
    0.95 * controlBackgroundOpacity
  }), rgba(0, 0, 0, ${
    0.8 * controlBackgroundOpacity
  }), rgba(0, 0, 0, 0))`;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      data-player-root=""
      className={`relative w-full select-none overflow-hidden bg-black outline-none ${
        fullscreen ? "h-screen" : ""
      } ${!showControlsClass && playing ? "cursor-none" : ""}`}
      onPointerMove={showControls}
      onPointerDown={showControls}
      onPointerLeave={() => {
        if (!playing || openMenu !== null || shortcutsOpen) return;
        if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = window.setTimeout(() => {
          setControlsVisible(false);
          hideTimerRef.current = null;
        }, 700);
      }}
    >
      {isVideo ? (
        <video
          ref={(element) => {
            mediaRef.current = element;
          }}
          playsInline
          preload="metadata"
          className={`w-full bg-black object-contain ${
            fullscreen ? "h-full" : "max-h-[76vh]"
          }`}
          onClick={handleSurfaceClick}
        />
      ) : (
        <div
          className={`relative flex w-full items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_25%_20%,rgba(59,130,246,0.22),transparent_45%),radial-gradient(circle_at_80%_80%,rgba(168,85,247,0.18),transparent_45%),linear-gradient(135deg,#0a0a0a,#111827_60%,#030712)] ${
            fullscreen ? "h-[calc(100vh-8rem)]" : "aspect-video max-h-[60vh] min-h-[15rem]"
          }`}
          onClick={handleSurfaceClick}
        >
          <div className="pointer-events-none absolute -left-10 top-6 h-56 w-56 rounded-full bg-blue-500/15 blur-3xl" />
          <div className="pointer-events-none absolute bottom-0 right-0 h-64 w-64 rounded-full bg-fuchsia-500/10 blur-3xl" />
          <div className="relative z-10 flex flex-col items-center gap-3 px-6 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-white/10 bg-white/5 shadow-2xl shadow-black/50 backdrop-blur">
              <Music className="h-9 w-9 text-white/75" />
            </div>
            <p className="max-w-xl truncate text-base font-semibold text-white sm:text-lg">
              {file.name}
            </p>
            <p className="text-[11px] uppercase tracking-wider text-white/40">
              {workerName ? `${workerName} · ` : ""}Audio
            </p>
          </div>
          <audio
            ref={(element) => {
              mediaRef.current = element;
            }}
            preload="metadata"
            className="hidden"
          />
        </div>
      )}

      {/* Subtitles */}
      {subtitles.activeCues.length > 0 && (
        <div
          className="pointer-events-none absolute inset-x-0 z-20 flex flex-col items-center gap-1 px-4 transition-[bottom] duration-200"
          style={{
            bottom: `calc(${subtitles.style.position}% + ${
              showControlsClass ? "3rem" : "0px"
            })`,
          }}
        >
          {subtitles.activeCues.map((cue, index) => (
            <div
              key={`${cue.start}-${cue.end}-${index}`}
              className="flex w-full"
              style={{
                justifyContent:
                  subtitles.style.align === "left"
                    ? "flex-start"
                    : subtitles.style.align === "right"
                      ? "flex-end"
                      : "center",
              }}
            >
              <div
                style={subtitleCueStyle}
                dangerouslySetInnerHTML={{ __html: cue.text }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Top bar */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 z-[65] px-3 pb-10 pt-3 transition-opacity duration-200 ${
          showControlsClass ? "opacity-100" : "invisible opacity-0"
        }`}
        style={{ backgroundImage: topBarBackground }}
      >
        <div className="pointer-events-auto flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white" title={file.name}>
              {file.name}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-white/50">
              {workerName ? `${workerName} · ` : ""}
              {activeChapter ? activeChapter.title : isVideo ? "Streaming" : "Audio"}
            </p>
          </div>
          <button
            type="button"
            onClick={onDownload}
            disabled={downloading}
            className={CONTROL_BUTTON}
            title="Download this file"
            aria-label="Download this file"
          >
            {downloading ? (
              <Loader2 className="h-[18px] w-[18px] animate-spin" />
            ) : (
              <Download className="h-[18px] w-[18px]" />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className={CONTROL_BUTTON}
            title="Close player"
            aria-label="Close player"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>

      {status === "ready" && waiting && (
        <div className="pointer-events-none absolute inset-0 z-[45] flex items-center justify-center">
          <div className="rounded-full bg-black/55 p-4 backdrop-blur">
            <Loader2 className="h-8 w-8 animate-spin text-white" />
          </div>
        </div>
      )}

      {/* Preparing / loading */}
      {status !== "ready" && status !== "error" && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center text-white">
          <Loader2 className="h-8 w-8 animate-spin" />
          {status === "preparing" ? (
            <>
              <p className="text-sm">
                Preparing stream… {Math.round(progress * 100)}%
                {speed != null && speed > 0
                  ? ` · ${speed >= 10 ? Math.round(speed) : speed.toFixed(1)}× realtime`
                  : ""}
              </p>
              <div className="h-1.5 w-56 overflow-hidden rounded-full bg-white/20">
                <div
                  className="h-full rounded-full bg-white transition-[width] duration-500"
                  style={{ width: `${Math.max(3, Math.round(progress * 100))}%` }}
                />
              </div>
              <p className="max-w-sm text-xs text-white/55">
                {sourceHeight != null && targetHeight != null && targetHeight < sourceHeight
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
              <p className="max-w-sm text-xs text-white/55">
                {source?.kind === "hls"
                  ? "Adaptive stream — quality options appear in Settings when available."
                  : sourceHeight != null && targetHeight != null && targetHeight < sourceHeight
                    ? `Converting ${sourceHeight}p to ${targetHeight}p on the worker as you watch.`
                    : "Remote formats are converted on the worker — this can take a moment."}
              </p>
            </>
          )}
        </div>
      )}

      {/* Error */}
      {status === "error" && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/85 px-6 text-center text-white">
          <AlertCircle className="h-8 w-8" />
          <p className="max-w-md text-sm">{errorMessage}</p>
          <p className="max-w-md text-xs text-white/55">
            The file may have been removed, the worker may be offline, or this browser
            cannot decode the stream.
          </p>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black transition hover:bg-white/90"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Try again
            </button>
            <button
              type="button"
              onClick={onDownload}
              disabled={downloading}
              className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20 disabled:opacity-50"
            >
              {downloading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Download instead
            </button>
          </div>
        </div>
      )}

      {/* Toasts: download errors and resume */}
      {(downloadError !== null ||
        (resumeToast !== null && status === "ready")) && (
        <div className="absolute bottom-24 left-3 z-[60] flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-2">
          {downloadError !== null && (
            <div className="flex max-w-full items-center gap-2 rounded-lg border border-red-400/30 bg-red-950/90 px-3 py-2 text-xs text-red-100 shadow-xl backdrop-blur">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{downloadError}</span>
              <button
                type="button"
                onClick={onDismissDownloadError}
                className="shrink-0 rounded p-1 text-red-200/70 transition hover:bg-white/10 hover:text-white"
                aria-label="Dismiss download error"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          {resumeToast !== null && status === "ready" && (
            <div className="flex max-w-full items-center gap-2 rounded-lg border border-white/10 bg-neutral-900/95 px-3 py-2 text-xs text-white shadow-xl backdrop-blur">
              <span className="truncate">Resumed from {formatTime(resumeToast)}</span>
              <button
                type="button"
                onClick={startOver}
                className="shrink-0 rounded bg-white/10 px-2 py-1 font-medium transition hover:bg-white/20"
              >
                Start over
              </button>
              <button
                type="button"
                onClick={() => setResumeToast(null)}
                className="shrink-0 rounded p-1 text-white/50 transition hover:bg-white/10 hover:text-white"
                aria-label="Dismiss resume message"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Stats */}
      {statsOpen && stats && (
        <div className="absolute right-3 top-16 z-[66] w-64 rounded-xl border border-white/10 bg-black/85 p-3 text-[11px] text-white/70 shadow-2xl backdrop-blur">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/40">
            Playback statistics
          </p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            <dt>Resolution</dt>
            <dd className="text-right text-white/90">
              {stats.width > 0 ? `${stats.width}×${stats.height}` : "—"}
            </dd>
            <dt>Quality</dt>
            <dd className="text-right text-white/90">{stats.level ?? "—"}</dd>
            <dt>Buffer</dt>
            <dd className="text-right text-white/90">{stats.bufferAhead.toFixed(1)}s</dd>
            {isVideo && (
              <>
                <dt>Video buffer</dt>
                <dd className="text-right text-white/90">
                  {stats.videoBufferAhead.toFixed(1)}s
                </dd>
              </>
            )}
            <dt>Bandwidth</dt>
            <dd className="text-right text-white/90">{formatBitrate(stats.bandwidth)}</dd>
            <dt>Dropped</dt>
            <dd className="text-right text-white/90">
              {stats.droppedFrames}
              {stats.totalFrames > 0
                ? ` / ${stats.totalFrames} (${(
                    (stats.droppedFrames / stats.totalFrames) *
                    100
                  ).toFixed(1)}%)`
                : ""}
            </dd>
            {isVideo && (
              <>
                <dt>Stalls</dt>
                <dd className="text-right text-white/90">
                  {stats.freezeCount}
                  {stats.lastFreezeMs > 0
                    ? ` · ${(stats.lastFreezeMs / 1000).toFixed(1)}s`
                    : ""}
                </dd>
              </>
            )}
            <dt>Engine</dt>
            <dd className="text-right text-white/90">{engine.engineLabel ?? "—"}</dd>
          </dl>
        </div>
      )}

      {/* Bottom controls */}
      <div
        className={`absolute inset-x-0 bottom-0 z-40 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-12 transition-opacity duration-200 ${
          showControlsClass ? "opacity-100" : "pointer-events-none invisible opacity-0"
        }`}
        style={{ backgroundImage: bottomBarBackground }}
      >
        <SeekBar
          currentTime={currentTime}
          duration={duration}
          buffered={buffered}
          chapters={chapters}
          thumbnailUrlBase={isVideo ? (urls?.thumbnailUrlBase ?? null) : null}
          mediaQuery={urls?.mediaQuery ?? ""}
          onSeek={seekTo}
          onScrubStart={() => {
            setControlsVisible(true);
            if (hideTimerRef.current !== null) {
              window.clearTimeout(hideTimerRef.current);
              hideTimerRef.current = null;
            }
          }}
          onScrubEnd={scheduleHide}
        />

        <div className="mt-0.5 flex items-center gap-0.5 sm:gap-1">
          <button
            type="button"
            onClick={togglePlay}
            className={CONTROL_BUTTON}
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause (K)" : "Play (K)"}
          >
            {playing ? (
              <Pause className="h-5 w-5" fill="currentColor" />
            ) : (
              <Play className="ml-0.5 h-5 w-5" fill="currentColor" />
            )}
          </button>

          <div className="flex items-center">
            <button
              type="button"
              onClick={toggleMute}
              className={CONTROL_BUTTON}
              aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
              title={muted || volume === 0 ? "Unmute (M)" : "Mute (M)"}
            >
              {muted || volume === 0 ? (
                <VolumeX className="h-[18px] w-[18px]" />
              ) : (
                <Volume2 className="h-[18px] w-[18px]" />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(event) => changeVolume(Number(event.target.value))}
              aria-label="Volume"
              className="player-range hidden w-20 md:block"
            />
          </div>

          <span className="ml-1 whitespace-nowrap text-[11px] tabular-nums text-white/65">
            {formatTime(currentTime)}
            <span className="hidden text-white/35 sm:inline"> / {formatTime(duration)}</span>
          </span>

          <div className="flex-1" />

          {hasPreviousValue && (
            <button
              type="button"
              onClick={onPreviousFile}
              className={`${CONTROL_BUTTON} hidden sm:flex`}
              title="Previous file (B)"
              aria-label="Previous file"
            >
              <SkipBack className="h-[18px] w-[18px]" />
            </button>
          )}
          {hasNextValue && (
            <button
              type="button"
              onClick={onNextFile}
              className={`${CONTROL_BUTTON} hidden sm:flex`}
              title="Next file (N)"
              aria-label="Next file"
            >
              <SkipForward className="h-[18px] w-[18px]" />
            </button>
          )}

          {audioOptions.length > 0 && (
            <AudioMenu
              open={openMenu === "audio"}
              onToggle={() => setOpenMenu(openMenu === "audio" ? null : "audio")}
              onClose={() => setOpenMenu(null)}
              options={audioOptions}
              selectedId={selectedAudioId}
              onSelect={handleSelectAudio}
              switchable={engine.switchableAudio}
            />
          )}

          <SubtitleMenu
            open={openMenu === "subtitles"}
            onToggle={() =>
              setOpenMenu(openMenu === "subtitles" ? null : "subtitles")
            }
            onClose={() => setOpenMenu(null)}
            tracks={subtitleOptions}
            selectedId={subtitles.selectedId}
            onSelect={(id) => {
              subtitles.selectSubtitle(id);
            }}
            loading={subtitles.loading}
            error={subtitles.error}
            style={subtitles.style}
            onStyleChange={subtitles.updateStyle}
            onResetStyle={subtitles.resetStyle}
            delay={subtitles.delay}
            onDelayChange={subtitles.setDelay}
          />

          {chapters.length > 0 && (
            <div className="hidden sm:block">
              <ChapterMenu
                open={openMenu === "chapters"}
                onToggle={() =>
                  setOpenMenu(openMenu === "chapters" ? null : "chapters")
                }
                onClose={() => setOpenMenu(null)}
                chapters={chapters}
                currentTime={currentTime}
                onSeek={seekTo}
              />
            </div>
          )}

          <SettingsMenu
            open={openMenu === "settings"}
            onToggle={() =>
              setOpenMenu(openMenu === "settings" ? null : "settings")
            }
            onClose={() => setOpenMenu(null)}
            rate={rate}
            onRateChange={changeRate}
            levels={engine.levels}
            currentLevel={engine.currentLevel}
            autoLevel={engine.autoLevel}
            onQualityChange={engine.selectQuality}
            loop={loop}
            onLoopChange={setLoop}
            autoplayNext={autoplayNext}
            onAutoplayNextChange={setAutoplayNext}
            controlBackgroundOpacity={controlBackgroundOpacity}
            onControlBackgroundOpacityChange={setControlBackgroundOpacity}
            hasNext={hasNextValue}
            statsOpen={statsOpen}
            onToggleStats={() => setStatsOpen((current) => !current)}
            onShowShortcuts={() => {
              setOpenMenu(null);
              setShortcutsOpen(true);
            }}
          />

          {isVideo && pipSupported && (
            <button
              type="button"
              onClick={() => void togglePip()}
              className={`${CONTROL_BUTTON} hidden sm:flex ${
                pipActive ? "bg-white/10 text-white" : ""
              }`}
              title="Picture-in-Picture (P)"
              aria-label="Picture-in-Picture"
            >
              <PictureInPicture2 className="h-[18px] w-[18px]" />
            </button>
          )}

          <button
            type="button"
            onClick={toggleFullscreen}
            className={CONTROL_BUTTON}
            title={fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {fullscreen ? (
              <Minimize className="h-[18px] w-[18px]" />
            ) : (
              <Maximize className="h-[18px] w-[18px]" />
            )}
          </button>
        </div>
      </div>

      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
