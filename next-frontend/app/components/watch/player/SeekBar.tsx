"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  isFreePinggyPlaybackUrl,
  type WorkerChapter,
} from "@/app/lib/workerConnection";
import { formatTime } from "./format";

interface BufferedRange {
  start: number;
  end: number;
}

interface Props {
  currentTime: number;
  duration: number;
  buffered: BufferedRange[];
  chapters: WorkerChapter[];
  thumbnailUrlBase: string | null;
  mediaQuery: string;
  onSeek: (time: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}

/** Punch a 2px transparent gap through the track at each chapter boundary. */
function chapterGapMask(positions: number[]): string | undefined {
  if (positions.length === 0) return undefined;
  const stops = ["#fff 0%"];
  for (const position of positions) {
    stops.push(`#fff calc(${position}% - 1px)`);
    stops.push(`transparent calc(${position}% - 1px)`);
    stops.push(`transparent calc(${position}% + 1px)`);
    stops.push(`#fff calc(${position}% + 1px)`);
  }
  stops.push("#fff 100%");
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

export function SeekBar({
  currentTime,
  duration,
  buffered,
  chapters,
  thumbnailUrlBase,
  mediaQuery,
  onSeek,
  onScrubStart,
  onScrubEnd,
}: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const scrubbingRef = useRef(false);
  const previewCooldownUntilRef = useRef(0);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const played = safeDuration > 0 ? Math.min(1, currentTime / safeDuration) : 0;
  const hoverTime = hoverRatio !== null ? hoverRatio * safeDuration : null;
  const chapterGapPositions =
    safeDuration > 0
      ? [
          ...new Set(
            chapters
              .filter((chapter) => chapter.start > 0)
              .map((chapter) => (chapter.start / safeDuration) * 100)
              .filter((position) => position > 0 && position < 100),
          ),
        ].sort((a, b) => a - b)
      : [];
  const trackMask = chapterGapMask(chapterGapPositions);
  const trackMaskStyle: CSSProperties | undefined = trackMask
    ? { maskImage: trackMask, WebkitMaskImage: trackMask }
    : undefined;

  const ratioFromClientX = (clientX: number): number => {
    const element = trackRef.current;
    if (!element) return 0;
    const rect = element.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  useEffect(() => {
    if (
      !thumbnailUrlBase ||
      hoverTime === null ||
      safeDuration <= 0 ||
      Date.now() < previewCooldownUntilRef.current
    ) {
      setPreviewSrc(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const query = mediaQuery ? mediaQuery.replace(/^\?/, "&") : "";
      const url = `${thumbnailUrlBase}?t=${hoverTime.toFixed(2)}&w=320${query}`;
      const needsPinggyBypass = isFreePinggyPlaybackUrl(thumbnailUrlBase);
      void (async () => {
        try {
          // An <img> cannot send the Pinggy bypass header, so fetch the JPEG
          // and hand the renderer a blob URL instead.
          const response = await fetch(url, {
            signal: controller.signal,
            ...(needsPinggyBypass
              ? { headers: { "X-Pinggy-No-Screen": "1" } }
              : {}),
          });
          if (!response.ok) throw new Error(`thumbnail ${response.status}`);
          const blob = await response.blob();
          if (cancelled || blob.size === 0) return;
          objectUrl = URL.createObjectURL(blob);
          setPreviewSrc(objectUrl);
          setPreviewFailed(false);
        } catch {
          if (cancelled) return;
          // The worker generates previews with a tiny ffmpeg pool, so a busy
          // 404 is normal. Back off for a few seconds instead of disabling
          // previews for the rest of the session.
          previewCooldownUntilRef.current = Date.now() + 8000;
          setPreviewSrc(null);
          setPreviewFailed(true);
        }
      })();
    }, 180);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hoverTime, mediaQuery, safeDuration, thumbnailUrlBase]);

  const seekToRatio = (ratio: number) => {
    if (safeDuration <= 0) return;
    onSeek(Math.max(0, Math.min(safeDuration, ratio * safeDuration)));
  };

  return (
    <div
      className="group/seek relative flex h-8 w-full cursor-pointer touch-none select-none items-center"
      onPointerMove={(event) => {
        setHoverRatio(ratioFromClientX(event.clientX));
      }}
      onPointerLeave={() => {
        if (!scrubbingRef.current) setHoverRatio(null);
      }}
    >
      {hoverRatio !== null && safeDuration > 0 && (
        <div
          className="pointer-events-none absolute bottom-6 z-20 flex -translate-x-1/2 flex-col items-center gap-1"
          style={{
            left: `clamp(5rem, ${hoverRatio * 100}%, calc(100% - 5rem))`,
          }}
        >
          {previewSrc && !previewFailed && (
            <img
              src={previewSrc}
              alt=""
              draggable={false}
              onError={() => {
                previewCooldownUntilRef.current = Date.now() + 8000;
                setPreviewFailed(true);
              }}
              className="h-auto w-32 rounded-md border border-white/20 bg-black object-cover shadow-xl sm:w-40"
            />
          )}
          <span className="rounded bg-black/90 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white shadow">
            {formatTime(hoverTime ?? 0)}
          </span>
        </div>
      )}

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(safeDuration)}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={`${formatTime(currentTime)} of ${formatTime(safeDuration)}`}
        className="relative w-full outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
        onPointerDown={(event) => {
          event.preventDefault();
          scrubbingRef.current = true;
          setScrubbing(true);
          onScrubStart?.();
          const ratio = ratioFromClientX(event.clientX);
          setHoverRatio(ratio);
          seekToRatio(ratio);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!scrubbingRef.current) return;
          const ratio = ratioFromClientX(event.clientX);
          setHoverRatio(ratio);
          seekToRatio(ratio);
        }}
        onPointerUp={(event) => {
          if (!scrubbingRef.current) return;
          scrubbingRef.current = false;
          setScrubbing(false);
          seekToRatio(ratioFromClientX(event.clientX));
          onScrubEnd?.();
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch {
            /* pointer already released */
          }
        }}
        onPointerCancel={() => {
          scrubbingRef.current = false;
          setScrubbing(false);
          onScrubEnd?.();
        }}
        onKeyDown={(event) => {
          if (safeDuration <= 0) return;
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            const delta = event.key === "ArrowLeft" ? -5 : 5;
            onSeek(Math.max(0, Math.min(safeDuration, currentTime + delta)));
          } else if (event.key === "Home") {
            event.preventDefault();
            onSeek(0);
          } else if (event.key === "End") {
            event.preventDefault();
            onSeek(safeDuration);
          }
        }}
      >
        <div className="relative h-1.5 w-full overflow-visible rounded-full transition-all group-hover/seek:h-2 group-focus-visible/seek:h-2">
          <div
            className="absolute inset-0 overflow-visible rounded-full bg-white/20"
            style={trackMaskStyle}
          >
            {buffered.map((range, index) => {
              if (safeDuration <= 0) return null;
              const left = Math.max(0, Math.min(1, range.start / safeDuration));
              const right = Math.max(0, Math.min(1, range.end / safeDuration));
              if (right <= left) return null;
              return (
                <span
                  key={`${range.start}-${range.end}-${index}`}
                  className="absolute inset-y-0 rounded-full bg-white/30"
                  style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }}
                />
              );
            })}

            <span
              className="absolute inset-y-0 left-0 rounded-full bg-blue-500"
              style={{ width: `${played * 100}%` }}
            />
          </div>

          {chapters.map((chapter, index) => {
            if (safeDuration <= 0 || chapter.start <= 0) return null;
            return (
              <span
                key={`${chapter.start}-${index}`}
                title={chapter.title}
                className="absolute -top-0.5 h-[calc(100%+4px)] w-0.5 -translate-x-1/2"
                style={{
                  left: `${Math.max(0, Math.min(100, (chapter.start / safeDuration) * 100))}%`,
                }}
              />
            );
          })}

          <span
            className={`absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow-md transition-transform ${
              scrubbing ? "scale-125" : "scale-0 group-hover/seek:scale-100 group-focus-visible/seek:scale-100"
            }`}
            style={{ left: `calc(${played * 100}% - 0.4375rem)` }}
          />
        </div>
      </div>
    </div>
  );
}
