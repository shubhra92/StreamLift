"use client";

import { ListVideo } from "lucide-react";
import type { PlayerChapter } from "./types";
import { formatTime } from "./format";
import { MenuItem, MenuNote, PlayerMenuButton } from "./Menu";

interface Props {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  chapters: PlayerChapter[];
  currentTime: number;
  onSeek: (time: number) => void;
}

export function ChapterMenu({
  open,
  onToggle,
  onClose,
  chapters,
  currentTime,
  onSeek,
}: Props) {
  const activeIndex = chapters.findIndex(
    (chapter) => currentTime >= chapter.start && currentTime < chapter.end,
  );

  return (
    <PlayerMenuButton
      open={open}
      onToggle={onToggle}
      onClose={onClose}
      label="Chapters"
      active={open}
      icon={<ListVideo className="h-[18px] w-[18px]" />}
    >
      <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-white/40">
        Chapters
      </p>
      {chapters.map((chapter, index) => (
        <MenuItem
          key={`${chapter.start}-${index}`}
          title={chapter.title}
          subtitle={formatTime(chapter.start)}
          selected={index === activeIndex}
          onClick={() => {
            onSeek(chapter.start);
            onClose();
          }}
        />
      ))}
      {chapters.length === 0 && (
        <MenuNote>This file does not contain chapter markers.</MenuNote>
      )}
    </PlayerMenuButton>
  );
}
