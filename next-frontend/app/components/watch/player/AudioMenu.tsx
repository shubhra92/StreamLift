"use client";

import { AudioLines } from "lucide-react";
import {
  MenuDivider,
  MenuItem,
  MenuNote,
  PlayerMenuButton,
} from "./Menu";
import { languageName, type PlayerAudioOption } from "./types";

interface Props {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  options: PlayerAudioOption[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** True when the current delivery path can switch without a reload. */
  switchable: boolean;
}

export function AudioMenu({
  open,
  onToggle,
  onClose,
  options,
  selectedId,
  onSelect,
  switchable,
}: Props) {
  return (
    <PlayerMenuButton
      open={open}
      onToggle={onToggle}
      onClose={onClose}
      label="Audio track"
      active={open}
      icon={<AudioLines className="h-[18px] w-[18px]" />}
      badge={options.length > 1 ? options.length : null}
    >
      <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-white/40">
        Audio
      </p>
      {options.map((track) => {
        const details = [
          track.language ? languageName(track.language) : null,
          track.codec ? track.codec.toUpperCase() : null,
          track.channels ? `${track.channels} channels` : null,
          track.default ? "Default" : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <MenuItem
            key={track.id}
            title={track.label}
            subtitle={details}
            disabled={options.length > 1 && !switchable}
            selected={selectedId === track.id}
            onClick={() => onSelect(track.id)}
          />
        );
      })}
      {options.length === 0 && <MenuNote>No audio track reported for this file.</MenuNote>}
      {options.length === 1 && (
        <MenuNote>This file has a single audio track.</MenuNote>
      )}
      {options.length > 1 && !switchable && (
        <>
          <MenuDivider />
          <MenuNote>
            This browser cannot switch audio tracks for this delivery path without
            reloading the file.
          </MenuNote>
        </>
      )}
    </PlayerMenuButton>
  );
}
