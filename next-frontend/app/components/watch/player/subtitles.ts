import type { SubtitleCue, SubtitleStyle } from "./types";

const ALLOWED_TAGS = new Set(["B", "I", "U", "EM", "STRONG", "BR"]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeHtml(node.nodeValue ?? "");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const element = node as HTMLElement;
  const children = Array.from(element.childNodes).map(renderNode).join("");
  if (!ALLOWED_TAGS.has(element.tagName)) return children;

  const tag = element.tagName.toLowerCase();
  if (tag === "br") return "<br/>";
  return `<${tag}>${children}</${tag}>`;
}

/**
 * Normalise ASS/SSA text residue that can survive a conversion to WebVTT.
 *
 * Some subtitle sources (or SRT tracks carrying ASS markup) leave formatting
 * commands in the cue text. They are not valid WebVTT and must not be shown
 * literally: override blocks are removed, `\N`/`\n` become real line breaks,
 * and `\h` becomes one non-breaking space per occurrence.
 *
 * A normal space would be collapsed by the overlay's `white-space: pre-line`,
 * so `\h\h` would look like a single space. U+00A0 is not collapsible and is
 * also what ASS/SSA mean by a hard space.
 *
 * The override-block pattern deliberately requires a backslash command, so a
 * literal `{word}` in dialogue is preserved. Escapes are resolved in a single
 * pass so `\\N` stays a literal backslash followed by "N" rather than becoming
 * a line break.
 */
export function normalizeAssCueText(text: string): string {
  if (!text) return "";
  return text
    .replace(/\{[^}]*\\[^}]*\}/g, "")
    .replace(/\\(\\|[Nn]|h)/g, (_match, code: string) => {
      if (code === "\\") return "\\";
      if (code === "h") return "\u00A0";
      return "\n";
    });
}

/**
 * Keep only safe inline formatting from a WebVTT cue.
 *
 * ffmpeg can emit `<i>`, `<b>`, voice tags and ASS override residue. Voice,
 * class and timestamp tags are unwrapped; scripts and attributes are dropped.
 */
export function sanitizeCueHtml(text: string): string {
  const normalized = normalizeAssCueText(text);
  if (!normalized) return "";
  if (typeof DOMParser === "undefined") return escapeHtml(normalized);
  try {
    const document = new DOMParser().parseFromString(
      `<body><div id="cue">${normalized}</div></body>`,
      "text/html",
    );
    const root = document.getElementById("cue");
    if (!root) return escapeHtml(normalized);
    return Array.from(root.childNodes).map(renderNode).join("");
  } catch {
    return escapeHtml(normalized);
  }
}

function parseTimestamp(raw: string): number | null {
  const value = raw.trim().replace(",", ".");
  if (!value) return null;
  const pieces = value.split(":");
  if (pieces.length < 2 || pieces.length > 3) return null;
  const seconds = Number(pieces[pieces.length - 1]);
  const minutes = Number(pieces[pieces.length - 2]);
  const hours = pieces.length === 3 ? Number(pieces[0]) : 0;
  if (
    !Number.isFinite(seconds) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(hours)
  ) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Parse a WebVTT file into cues. Cue settings (line/position/align) are
 * intentionally ignored: the player renders cues with user-controlled styling.
 */
export function parseVtt(source: string): SubtitleCue[] {
  const normalised = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const blocks = normalised.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length === 0) continue;
    const first = lines[0].trim();
    if (
      !first ||
      first.startsWith("WEBVTT") ||
      first.startsWith("NOTE") ||
      first.startsWith("STYLE") ||
      first.startsWith("REGION")
    ) {
      continue;
    }

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;

    const timing = lines[timingIndex];
    const [startRaw, endRaw] = timing.split("-->");
    if (!startRaw || !endRaw) continue;

    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw.trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null || end <= start) continue;

    const payload = lines.slice(timingIndex + 1).join("\n").trim();
    if (!payload) continue;

    const html = sanitizeCueHtml(payload);
    if (!html.trim()) continue;
    cues.push({ start, end, text: html });
  }

  cues.sort((a, b) => a.start - b.start);
  return cues;
}

export function cuesAt(cues: SubtitleCue[], time: number): SubtitleCue[] {
  if (cues.length === 0) return [];
  // Cues are sorted; a linear scan is fine for the few thousand cues a film
  // has, and avoids binary-search edge cases with overlapping cues.
  return cues.filter((cue) => time >= cue.start && time <= cue.end);
}

export function hexToRgba(hex: string, alpha: number): string {
  const value = (hex || "").replace(/^#/, "");
  const opacity = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 0));
  if (!/^[0-9a-f]{6}$/i.test(value)) {
    return `rgba(0, 0, 0, ${opacity})`;
  }
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

export function subtitleFontFamily(style: SubtitleStyle): string {
  switch (style.fontFamily) {
    case "sans":
      return 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
    case "serif":
      return 'ui-serif, Georgia, Cambria, "Times New Roman", serif';
    case "mono":
      return 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    case "rounded":
      return '"SF Pro Rounded", ui-rounded, "Nunito", "Varela Round", system-ui, sans-serif';
    default:
      return 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  }
}

/** Outline drawn as a text-shadow ring, independent of the background. */
export function subtitleTextShadow(style: SubtitleStyle): string | undefined {
  const shadows: string[] = [];
  if (style.outline && style.outlineWidth > 0) {
    const width = style.outlineWidth;
    for (let x = -width; x <= width; x += 1) {
      for (let y = -width; y <= width; y += 1) {
        if (x === 0 && y === 0) continue;
        if (Math.abs(x) + Math.abs(y) > width + 0.5) continue;
        shadows.push(`${x}px ${y}px 0 rgba(0,0,0,0.95)`);
      }
    }
  }
  if (style.shadow) {
    shadows.push("0 3px 10px rgba(0,0,0,0.9)");
  }
  return shadows.length > 0 ? shadows.join(", ") : undefined;
}
