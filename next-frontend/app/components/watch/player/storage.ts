import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyle } from "./types";

export interface PlayerPrefs {
  volume: number;
  muted: boolean;
  rate: number;
  loop: boolean;
  autoplayNext: boolean;
}

export const DEFAULT_PLAYER_PREFS: PlayerPrefs = {
  volume: 1,
  muted: false,
  rate: 1,
  loop: false,
  autoplayNext: false,
};

const PREFS_KEY = "streamlift:player:prefs";
const SUBTITLE_STYLE_KEY = "streamlift:player:subtitle-style";

function readJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be disabled or full */
  }
}

function remove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function loadPlayerPrefs(): PlayerPrefs {
  const stored = readJson<Partial<PlayerPrefs>>(PREFS_KEY);
  if (!stored) return { ...DEFAULT_PLAYER_PREFS };
  return {
    volume:
      typeof stored.volume === "number" && Number.isFinite(stored.volume)
        ? Math.max(0, Math.min(1, stored.volume))
        : DEFAULT_PLAYER_PREFS.volume,
    muted: Boolean(stored.muted),
    rate:
      typeof stored.rate === "number" && Number.isFinite(stored.rate)
        ? Math.max(0.25, Math.min(3, stored.rate))
        : DEFAULT_PLAYER_PREFS.rate,
    loop: Boolean(stored.loop),
    autoplayNext: Boolean(stored.autoplayNext),
  };
}

export function savePlayerPrefs(prefs: PlayerPrefs): void {
  writeJson(PREFS_KEY, prefs);
}

export function loadSubtitleStyle(): SubtitleStyle {
  const stored = readJson<Partial<SubtitleStyle>>(SUBTITLE_STYLE_KEY);
  return { ...DEFAULT_SUBTITLE_STYLE, ...(stored ?? {}) };
}

export function saveSubtitleStyle(style: SubtitleStyle): void {
  writeJson(SUBTITLE_STYLE_KEY, style);
}

interface ResumeEntry {
  position: number;
  updatedAt: number;
}

function resumeKey(fileKey: string): string {
  return `streamlift:player:resume:${fileKey}`;
}

export function loadResume(fileKey: string): number | null {
  const stored = readJson<ResumeEntry>(resumeKey(fileKey));
  if (!stored || typeof stored.position !== "number" || !Number.isFinite(stored.position)) {
    return null;
  }
  return stored.position > 0 ? stored.position : null;
}

export function saveResume(fileKey: string, position: number): void {
  if (!Number.isFinite(position) || position < 1) return;
  writeJson(resumeKey(fileKey), { position, updatedAt: Date.now() } satisfies ResumeEntry);
}

export function clearResume(fileKey: string): void {
  remove(resumeKey(fileKey));
}

function subtitleSelectionKey(fileKey: string): string {
  return `streamlift:player:subtitles:${fileKey}`;
}

/** `undefined` = never chosen, `-1` = explicitly off. */
export function loadSubtitleSelection(fileKey: string): number | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(subtitleSelectionKey(fileKey));
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function saveSubtitleSelection(fileKey: string, trackId: number | null): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(subtitleSelectionKey(fileKey), String(trackId ?? -1));
  } catch {
    /* ignore */
  }
}

function subtitleDelayKey(fileKey: string): string {
  return `streamlift:player:sub-delay:${fileKey}`;
}

export function loadSubtitleDelay(fileKey: string): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(subtitleDelayKey(fileKey));
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function saveSubtitleDelay(fileKey: string, delay: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(subtitleDelayKey(fileKey), String(delay));
  } catch {
    /* ignore */
  }
}

function audioPreferenceKey(fileKey: string): string {
  return `streamlift:player:audio:${fileKey}`;
}

export function loadAudioPreference(fileKey: string): number | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(audioPreferenceKey(fileKey));
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function saveAudioPreference(fileKey: string, trackId: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(audioPreferenceKey(fileKey), String(trackId));
  } catch {
    /* ignore */
  }
}
