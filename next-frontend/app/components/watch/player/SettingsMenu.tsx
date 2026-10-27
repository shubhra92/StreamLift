"use client";

import { Activity, Keyboard, Settings, SlidersHorizontal } from "lucide-react";
import {
  MenuDivider,
  MenuItem,
  MenuNote,
  MenuSection,
  PlayerMenuButton,
  RangeRow,
  ToggleRow,
} from "./Menu";

interface QualityLevel {
  id: number;
  name: string;
  height: number;
  bitrate: number;
}

interface Props {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  rate: number;
  onRateChange: (rate: number) => void;
  levels: QualityLevel[];
  currentLevel: number;
  autoLevel: boolean;
  onQualityChange: (level: number | "auto") => void;
  loop: boolean;
  onLoopChange: (loop: boolean) => void;
  autoplayNext: boolean;
  onAutoplayNextChange: (value: boolean) => void;
  controlBackgroundOpacity: number;
  onControlBackgroundOpacityChange: (value: number) => void;
  hideControlsOnSpacebarPause: boolean;
  onHideControlsOnSpacebarPauseChange: (value: boolean) => void;
  showPauseControlsOption: boolean;
  hasNext: boolean;
  statsOpen: boolean;
  onToggleStats: () => void;
  onShowShortcuts: () => void;
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function SettingsMenu({
  open,
  onToggle,
  onClose,
  rate,
  onRateChange,
  levels,
  currentLevel,
  autoLevel,
  onQualityChange,
  loop,
  onLoopChange,
  autoplayNext,
  onAutoplayNextChange,
  controlBackgroundOpacity,
  onControlBackgroundOpacityChange,
  hideControlsOnSpacebarPause,
  onHideControlsOnSpacebarPauseChange,
  showPauseControlsOption,
  hasNext,
  statsOpen,
  onToggleStats,
  onShowShortcuts,
}: Props) {
  const sortedLevels = [...levels].sort((a, b) => b.height - a.height);

  return (
    <PlayerMenuButton
      open={open}
      onToggle={onToggle}
      onClose={onClose}
      label="Playback settings"
      active={open}
      icon={<Settings className="h-[18px] w-[18px]" />}
    >
      <MenuSection>Playback speed</MenuSection>
      <div className="grid grid-cols-5 gap-1 px-1.5 pb-2">
        {SPEEDS.map((speed) => (
          <button
            key={speed}
            type="button"
            onClick={() => onRateChange(speed)}
            className={`rounded-md px-1 py-1.5 text-[11px] font-medium tabular-nums transition ${
              Math.abs(rate - speed) < 0.001
                ? "bg-blue-500 text-white"
                : "bg-white/10 text-white/70 hover:bg-white/15"
            }`}
          >
            {speed === 1 ? "1×" : `${speed}×`}
          </button>
        ))}
      </div>

      {levels.length > 1 && (
        <>
          <MenuDivider />
          <MenuSection>Quality</MenuSection>
          <MenuItem
            title="Auto"
            subtitle={`Adapts to connection speed${
              autoLevel ? " · current" : ""
            }`}
            selected={autoLevel}
            onClick={() => onQualityChange("auto")}
          />
          {sortedLevels.map((level) => (
            <MenuItem
              key={level.id}
              title={
                level.name ||
                (level.height ? `${level.height}p` : `Level ${level.id + 1}`)
              }
              subtitle={
                level.bitrate
                  ? `${Math.round(level.bitrate / 1000)} kbps`
                  : undefined
              }
              selected={!autoLevel && currentLevel === level.id}
              onClick={() => onQualityChange(level.id)}
            />
          ))}
        </>
      )}

      <MenuDivider />
      <ToggleRow
        label="Loop"
        description="Replay this file when it ends"
        checked={loop}
        onChange={onLoopChange}
      />
      <ToggleRow
        label="Autoplay next"
        description={hasNext ? "Play the next file automatically" : "No next file available"}
        checked={autoplayNext}
        onChange={onAutoplayNextChange}
      />
      {showPauseControlsOption && (
        <ToggleRow
          label="Clean pause with Space"
          description="Spacebar pauses without showing the title and control bar"
          checked={hideControlsOnSpacebarPause}
          onChange={onHideControlsOnSpacebarPauseChange}
        />
      )}

      <MenuDivider />
      <MenuSection>Appearance</MenuSection>
      <RangeRow
        label="Control background"
        value={controlBackgroundOpacity}
        min={0}
        max={1}
        step={0.05}
        display={`${Math.round(controlBackgroundOpacity * 100)}%`}
        onChange={onControlBackgroundOpacityChange}
      />
      <MenuNote>Set to 0% to remove the title and control-bar shading.</MenuNote>

      <MenuDivider />
      <MenuItem
        title="Playback statistics"
        subtitle="Resolution, buffer, dropped frames, bandwidth"
        icon={<Activity className="h-4 w-4" />}
        selected={statsOpen}
        onClick={onToggleStats}
      />
      <MenuItem
        title="Keyboard shortcuts"
        icon={<Keyboard className="h-4 w-4" />}
        onClick={onShowShortcuts}
      />

      {levels.length === 1 && (
        <>
          <MenuDivider />
          <MenuNote>
            <span className="inline-flex items-center gap-1">
              <SlidersHorizontal className="h-3 w-3" /> This file is available at a
              single quality.
            </span>
          </MenuNote>
        </>
      )}
    </PlayerMenuButton>
  );
}
