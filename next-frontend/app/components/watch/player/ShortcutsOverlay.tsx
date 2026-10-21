"use client";

import { X } from "lucide-react";

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "Space / K", action: "Play or pause" },
  { keys: "← / →", action: "Seek 5 seconds" },
  { keys: "J / L", action: "Seek 10 seconds" },
  { keys: "↑ / ↓", action: "Volume up / down" },
  { keys: "M", action: "Mute / unmute" },
  { keys: "F", action: "Fullscreen" },
  { keys: "P", action: "Picture-in-Picture" },
  { keys: "C", action: "Subtitles on / off" },
  { keys: "A", action: "Next audio track" },
  { keys: "N / B", action: "Next / previous file" },
  { keys: "< / >", action: "Slower / faster" },
  { keys: "0 – 9", action: "Jump to percent" },
  { keys: ", / .", action: "Frame step (paused)" },
  { keys: "I", action: "Playback statistics" },
  { keys: "?", action: "Show this help" },
  { keys: "Esc", action: "Close menu / player" },
];

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="absolute inset-0 z-[80] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-h-full w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-neutral-950/95 p-5 text-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 rounded-md p-1.5 text-white/60 transition hover:bg-white/10 hover:text-white"
          aria-label="Close keyboard shortcuts"
        >
          <X className="h-4 w-4" />
        </button>
        <h3 className="pr-8 text-base font-semibold">Keyboard shortcuts</h3>
        <p className="mt-0.5 text-xs text-white/45">
          Shortcuts work while the player is open.
        </p>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {SHORTCUTS.map((shortcut) => (
            <div
              key={shortcut.keys}
              className="flex items-center justify-between gap-3 border-b border-white/5 pb-1.5"
            >
              <dt className="text-[11px] text-white/55">{shortcut.action}</dt>
              <dd className="shrink-0 rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-white/80">
                {shortcut.keys}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
