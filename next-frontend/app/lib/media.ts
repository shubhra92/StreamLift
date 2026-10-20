/**
 * Media detection helpers for the Watch page.
 *
 * `kind` decides which player element to use; `native` decides whether the
 * browser can play the file directly or whether it must be remuxed/transcoded
 * into HLS by the worker's ffmpeg pipeline.
 */

export type MediaKind = "video" | "audio";

const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "webm", "mkv", "mov", "avi", "wmv", "flv",
  "ts", "m2ts", "mpg", "mpeg", "3gp", "ogv", "vob",
]);

const AUDIO_EXTENSIONS = new Set([
  "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus",
  "wma", "aiff", "aif", "mka", "alac",
]);

/** Containers/codecs browsers play without server help. */
const NATIVE_VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "mov", "ogv"]);
const NATIVE_AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus"]);

/**
 * Codec probes for worker-side playback negotiation.
 *
 * The worker can only copy a stream into MP4 when the browser reports it can
 * decode it; anything else is transcoded. Checking here (not assuming H.264)
 * lets H.264+AC3 stay on the cheap copy path and lets HEVC/AV1/VP9 copy on
 * browsers that support them.
 */
const CODEC_PROBES: ReadonlyArray<{ kind: "video" | "audio"; codec: string; type: string }> = [
  { kind: "video", codec: "h264", type: 'video/mp4; codecs="avc1.42E01E"' },
  { kind: "video", codec: "hevc", type: 'video/mp4; codecs="hvc1.1.6.L93.B0"' },
  { kind: "video", codec: "av1", type: 'video/mp4; codecs="av01.0.05M.08"' },
  { kind: "video", codec: "vp9", type: 'video/mp4; codecs="vp09.00.10.08"' },
  { kind: "audio", codec: "aac", type: 'audio/mp4; codecs="mp4a.40.2"' },
  { kind: "audio", codec: "mp3", type: "audio/mpeg" },
  { kind: "audio", codec: "opus", type: 'audio/mp4; codecs="opus"' },
  { kind: "audio", codec: "flac", type: 'audio/mp4; codecs="flac"' },
  { kind: "audio", codec: "ac3", type: 'audio/mp4; codecs="ac-3"' },
  { kind: "audio", codec: "eac3", type: 'audio/mp4; codecs="ec-3"' },
];

export interface PlaybackCapabilities {
  video: string[];
  audio: string[];
}

let cachedCapabilities: PlaybackCapabilities | null = null;

/** Probe the browser once for every codec the worker can copy. */
export function detectPlaybackCapabilities(): PlaybackCapabilities {
  if (cachedCapabilities) return cachedCapabilities;
  const video: string[] = [];
  const audio: string[] = [];
  if (typeof document === "undefined") {
    cachedCapabilities = { video: ["h264"], audio: ["aac", "mp3"] };
    return cachedCapabilities;
  }
  const probe = document.createElement("video");
  const supported = (type: string): boolean => {
    try {
      const result = probe.canPlayType(type);
      return result === "probably" || result === "maybe";
    } catch {
      return false;
    }
  };
  for (const { kind, codec, type } of CODEC_PROBES) {
    if (!supported(type)) continue;
    (kind === "video" ? video : audio).push(codec);
  }
  // Baseline guarantees: every browser we support decodes these.
  if (!video.includes("h264")) video.unshift("h264");
  if (!audio.includes("aac")) audio.push("aac");
  cachedCapabilities = { video, audio };
  return cachedCapabilities;
}

/**
 * Serialise capabilities for the worker: ``"h264,hevc|aac,mp3"``.
 * A stable order matters — the worker hashes the string into the artifact
 * directory name, and every request (ticket, playlist, segments) must map
 * back to the same session.
 */
export function playbackCapabilitiesString(): string {
  const caps = detectPlaybackCapabilities();
  return `${caps.video.join(",")}|${caps.audio.join(",")}`;
}

const MIME_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  ts: "video/mp2t",
  m2ts: "video/mp2t",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  "3gp": "video/3gpp",
  ogv: "video/ogg",
  vob: "video/mpeg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  wma: "audio/x-ms-wma",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  mka: "audio/x-matroska",
  alac: "audio/mp4",
};

export function getFileExtension(name: string): string {
  const base = name.split(/[?#]/)[0];
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** `"video"`, `"audio"`, or `null` when the file is not media. */
export function getMediaKind(name: string): MediaKind | null {
  const ext = getFileExtension(name);
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return null;
}

/** True when the browser can play the original bytes without ffmpeg. */
export function isNativePlayable(name: string): boolean {
  const ext = getFileExtension(name);
  return NATIVE_VIDEO_EXTENSIONS.has(ext) || NATIVE_AUDIO_EXTENSIONS.has(ext);
}

export function getMediaMime(name: string): string {
  return MIME_TYPES[getFileExtension(name)] ?? "application/octet-stream";
}
