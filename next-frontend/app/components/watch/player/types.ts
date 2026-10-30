import type {
  WorkerAudioTrack,
  WorkerChapter,
  WorkerSubtitleTrack,
} from "@/app/lib/workerConnection";

export type PlayerStatus = "connecting" | "preparing" | "loading" | "ready" | "error";

export type SourceKind = "direct" | "progressive" | "hls";

export interface PlaybackSource {
  kind: SourceKind;
  url: string;
}

export interface SubtitleStyle {
  fontFamily: "system" | "sans" | "serif" | "mono" | "rounded";
  scale: number;
  color: string;
  background: string;
  backgroundOpacity: number;
  outline: boolean;
  outlineWidth: number;
  shadow: boolean;
  position: number;
  lineHeight: number;
  weight: number;
  align: "center" | "left" | "right";
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily: "system",
  scale: 1,
  color: "#ffffff",
  background: "#000000",
  backgroundOpacity: 0.6,
  outline: true,
  outlineWidth: 2,
  shadow: false,
  position: 8,
  lineHeight: 1.35,
  weight: 600,
  align: "center",
};

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export interface PlayerAudioOption {
  id: number;
  label: string;
  language: string | null;
  codec: string | null;
  channels: number | null;
  default: boolean;
}

export interface PlayerSubtitleOption extends WorkerSubtitleTrack {
  label: string;
}

export interface PlayerChapter extends WorkerChapter {}

export type PlayerMenu =
  | "audio"
  | "subtitles"
  | "settings"
  | "chapters"
  | "quality"
  | null;

export interface PlayerStats {
  width: number;
  height: number;
  bufferAhead: number;
  videoBufferAhead: number;
  droppedFrames: number;
  totalFrames: number;
  freezeCount: number;
  lastFreezeMs: number;
  bandwidth: number | null;
  level: string | null;
  fps: number | null;
  lastError: string | null;
}

export function audioLabel(track: WorkerAudioTrack, position: number): string {
  const base =
    track.title?.trim() ||
    (track.language ? languageName(track.language) : "") ||
    `Track ${position + 1}`;
  return base;
}

export function subtitleLabel(track: WorkerSubtitleTrack, position: number): string {
  return (
    track.title?.trim() ||
    (track.language ? languageName(track.language) : "") ||
    `Subtitle ${position + 1}`
  );
}

/** "eng"/"en"/"english" → "English"; unknown codes are upper-cased. */
export function languageName(code: string): string {
  const key = code.trim().toLowerCase();
  if (!key || key === "und" || key === "unknown") return "";
  const names: Record<string, string> = {
    en: "English",
    eng: "English",
    ja: "Japanese",
    jpn: "Japanese",
    jp: "Japanese",
    hi: "Hindi",
    hin: "Hindi",
    bn: "Bengali",
    ben: "Bengali",
    ta: "Tamil",
    tam: "Tamil",
    te: "Telugu",
    tel: "Telugu",
    ml: "Malayalam",
    mal: "Malayalam",
    kn: "Kannada",
    kan: "Kannada",
    mr: "Marathi",
    mar: "Marathi",
    gu: "Gujarati",
    guj: "Gujarati",
    pa: "Punjabi",
    pan: "Punjabi",
    ur: "Urdu",
    urd: "Urdu",
    ko: "Korean",
    kor: "Korean",
    zh: "Chinese",
    chi: "Chinese",
    zho: "Chinese",
    fr: "French",
    fre: "French",
    fra: "French",
    de: "German",
    ger: "German",
    deu: "German",
    es: "Spanish",
    spa: "Spanish",
    pt: "Portuguese",
    por: "Portuguese",
    it: "Italian",
    ita: "Italian",
    ru: "Russian",
    rus: "Russian",
    ar: "Arabic",
    ara: "Arabic",
    tr: "Turkish",
    tur: "Turkish",
    th: "Thai",
    tha: "Thai",
    vi: "Vietnamese",
    vie: "Vietnamese",
    id: "Indonesian",
    ind: "Indonesian",
    nl: "Dutch",
    dut: "Dutch",
    nld: "Dutch",
    pl: "Polish",
    pol: "Polish",
    sv: "Swedish",
    swe: "Swedish",
    da: "Danish",
    dan: "Danish",
    no: "Norwegian",
    nor: "Norwegian",
    fi: "Finnish",
    fin: "Finnish",
    el: "Greek",
    gre: "Greek",
    ell: "Greek",
    he: "Hebrew",
    heb: "Hebrew",
    fa: "Persian",
    per: "Persian",
    fas: "Persian",
    uk: "Ukrainian",
    ukr: "Ukrainian",
    cs: "Czech",
    cze: "Czech",
    ces: "Czech",
    hu: "Hungarian",
    hun: "Hungarian",
    ro: "Romanian",
    rum: "Romanian",
    ron: "Romanian",
    sk: "Slovak",
    slo: "Slovak",
    slk: "Slovak",
  };
  return names[key] ?? key.toUpperCase();
}
