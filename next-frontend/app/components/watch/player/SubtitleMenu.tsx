"use client";

import { Captions, RotateCcw, Type } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ColorRow,
  MenuDivider,
  MenuItem,
  MenuNote,
  MenuSection,
  PlayerMenuButton,
  RangeRow,
  ToggleRow,
} from "./Menu";
import { formatSeconds } from "./format";
import {
  languageName,
  type PlayerSubtitleOption,
  type SubtitleStyle,
} from "./types";

interface Props {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  tracks: PlayerSubtitleOption[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  loading: boolean;
  error: string | null;
  style: SubtitleStyle;
  onStyleChange: (patch: Partial<SubtitleStyle>) => void;
  onResetStyle: () => void;
  delay: number;
  onDelayChange: (delay: number) => void;
}

function trackDetails(track: PlayerSubtitleOption): string {
  const bits: string[] = [];
  if (track.language) bits.push(languageName(track.language));
  if (track.codec) bits.push(track.codec.toUpperCase());
  if (track.forced) bits.push("Forced");
  if (track.default) bits.push("Default");
  if (track.bitmap) bits.push("Image-based");
  return bits.join(" · ");
}

export function SubtitleMenu({
  open,
  onToggle,
  onClose,
  tracks,
  selectedId,
  onSelect,
  loading,
  error,
  style,
  onStyleChange,
  onResetStyle,
  delay,
  onDelayChange,
}: Props) {
  const [tab, setTab] = useState<"tracks" | "style">("tracks");

  // Track selection is the primary action; always open on that tab.
  useEffect(() => {
    if (open) setTab("tracks");
  }, [open]);
  const textTracks = tracks.filter((track) => !track.bitmap);
  const bitmapTracks = tracks.filter((track) => track.bitmap);

  return (
    <PlayerMenuButton
      open={open}
      onToggle={onToggle}
      onClose={onClose}
      label="Subtitles"
      active={selectedId !== null || open}
      icon={<Captions className="h-[18px] w-[18px]" />}
      badge={selectedId !== null ? "CC" : textTracks.length > 0 ? textTracks.length : null}
    >
      <div className="flex items-center gap-1 border-b border-white/10 px-1.5 pb-1.5 pt-0.5">
        <button
          type="button"
          onClick={() => setTab("tracks")}
          className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition ${
            tab === "tracks" ? "bg-white/15 text-white" : "text-white/55 hover:bg-white/5"
          }`}
        >
          Subtitles
        </button>
        <button
          type="button"
          onClick={() => setTab("style")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition ${
            tab === "style" ? "bg-white/15 text-white" : "text-white/55 hover:bg-white/5"
          }`}
        >
          <Type className="h-3.5 w-3.5" />
          Appearance
        </button>
      </div>

      {tab === "tracks" ? (
        <>
          <MenuItem
            title="Off"
            selected={selectedId === null}
            onClick={() => {
              onSelect(null);
            }}
          />
          {textTracks.length > 0 && <MenuDivider />}
          {textTracks.map((track) => (
            <MenuItem
              key={track.index}
              title={track.label}
              subtitle={trackDetails(track)}
              selected={selectedId === track.index}
              onClick={() => onSelect(track.index)}
            />
          ))}

          {loading && (
            <p className="px-2.5 py-2 text-[11px] text-white/50">Loading subtitles…</p>
          )}
          {error && (
            <p className="px-2.5 py-2 text-[11px] text-amber-300/90">{error}</p>
          )}

          {bitmapTracks.length > 0 && (
            <>
              <MenuDivider />
              <MenuSection>Not supported in browser</MenuSection>
              {bitmapTracks.map((track) => (
                <MenuItem
                  key={track.index}
                  disabled
                  title={track.label}
                  subtitle={`${trackDetails(track)} — image subtitles need burn-in`}
                  onClick={() => undefined}
                />
              ))}
              <MenuNote>
                PGS/VobSub subtitles are pictures, not text. They can only be shown by
                re-encoding the video with subtitles burned in.
              </MenuNote>
            </>
          )}

          {tracks.length === 0 && (
            <MenuNote>This file has no embedded subtitle tracks.</MenuNote>
          )}
        </>
      ) : (
        <div className="pt-1">
          <RangeRow
            label="Size"
            value={style.scale}
            min={0.6}
            max={2.2}
            step={0.05}
            display={`${Math.round(style.scale * 100)}%`}
            onChange={(scale) => onStyleChange({ scale })}
          />
          <RangeRow
            label="Background opacity"
            value={style.backgroundOpacity}
            min={0}
            max={1}
            step={0.05}
            display={`${Math.round(style.backgroundOpacity * 100)}%`}
            onChange={(backgroundOpacity) => onStyleChange({ backgroundOpacity })}
          />
          <ColorRow
            label="Text color"
            value={style.color}
            onChange={(color) => onStyleChange({ color })}
          />
          <ColorRow
            label="Background"
            value={style.background}
            onChange={(background) => onStyleChange({ background })}
          />
          <RangeRow
            label="Vertical position"
            value={style.position}
            min={2}
            max={45}
            step={1}
            display={`${style.position}%`}
            onChange={(position) => onStyleChange({ position })}
          />
          <RangeRow
            label="Line height"
            value={style.lineHeight}
            min={1}
            max={2}
            step={0.05}
            display={style.lineHeight.toFixed(2)}
            onChange={(lineHeight) => onStyleChange({ lineHeight })}
          />

          <label className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] text-white/70">
            <span>Font</span>
            <select
              value={style.fontFamily}
              onChange={(event) =>
                onStyleChange({
                  fontFamily: event.target.value as SubtitleStyle["fontFamily"],
                })
              }
              className="rounded-md border border-white/15 bg-neutral-900 px-2 py-1 text-xs text-white outline-none"
            >
              <option value="system">System</option>
              <option value="sans">Sans</option>
              <option value="serif">Serif</option>
              <option value="mono">Monospace</option>
              <option value="rounded">Rounded</option>
            </select>
          </label>

          <label className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] text-white/70">
            <span>Weight</span>
            <select
              value={style.weight}
              onChange={(event) => onStyleChange({ weight: Number(event.target.value) })}
              className="rounded-md border border-white/15 bg-neutral-900 px-2 py-1 text-xs text-white outline-none"
            >
              <option value={400}>Normal</option>
              <option value={600}>Semibold</option>
              <option value={700}>Bold</option>
              <option value={800}>Extra bold</option>
            </select>
          </label>

          <div className="flex items-center justify-between px-2.5 py-1.5 text-[12px] text-white/70">
            <span>Alignment</span>
            <div className="flex gap-1">
              {(["left", "center", "right"] as const).map((align) => (
                <button
                  key={align}
                  type="button"
                  onClick={() => onStyleChange({ align })}
                  className={`rounded px-2 py-0.5 text-[11px] capitalize transition ${
                    style.align === align
                      ? "bg-blue-500 text-white"
                      : "bg-white/10 text-white/65 hover:bg-white/15"
                  }`}
                >
                  {align}
                </button>
              ))}
            </div>
          </div>

          <MenuDivider />
          <div className="flex items-center justify-between px-2.5 py-1">
            <span className="text-[12px] text-white/70">Subtitle delay</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onDelayChange(delay - 0.5)}
                className="rounded bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20"
              >
                −0.5s
              </button>
              <span className="w-14 text-center text-xs tabular-nums text-white/80">
                {formatSeconds(delay)}
              </span>
              <button
                type="button"
                onClick={() => onDelayChange(delay + 0.5)}
                className="rounded bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20"
              >
                +0.5s
              </button>
            </div>
          </div>
          <RangeRow
            label="Fine sync"
            value={delay}
            min={-30}
            max={30}
            step={0.1}
            display={formatSeconds(delay)}
            onChange={onDelayChange}
          />
          <div className="flex justify-end px-2.5 pb-1.5">
            <button
              type="button"
              onClick={() => onDelayChange(0)}
              className="rounded px-2 py-0.5 text-[11px] text-white/50 transition hover:bg-white/10 hover:text-white"
            >
              Reset sync
            </button>
          </div>
          <ToggleRow
            label="Outline"
            checked={style.outline}
            onChange={(outline) => onStyleChange({ outline })}
          />
          {style.outline && (
            <RangeRow
              label="Outline thickness"
              value={style.outlineWidth}
              min={1}
              max={4}
              step={1}
              display={`${style.outlineWidth}px`}
              onChange={(outlineWidth) => onStyleChange({ outlineWidth })}
            />
          )}
          <ToggleRow
            label="Drop shadow"
            checked={style.shadow}
            onChange={(shadow) => onStyleChange({ shadow })}
          />
          <MenuDivider />
          <button
            type="button"
            onClick={onResetStyle}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset subtitle appearance
          </button>
        </div>
      )}
    </PlayerMenuButton>
  );
}
