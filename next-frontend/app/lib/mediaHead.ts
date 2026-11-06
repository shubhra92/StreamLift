/**
 * Cheap container-header checks for cloud playback.
 *
 * The browser can only start decoding once it has real container bytes. A
 * zero-filled or structurally invalid head almost always means a sparse or
 * interrupted upload, and waiting for the player to fail (or downloading the
 * whole file for the blob fallback) is much worse than failing immediately.
 *
 * This is intentionally conservative: it only rejects headers that cannot be
 * valid for the detected browser-native container. Unknown MIME types are left
 * to the player.
 */

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return "";
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function isMp4BoxType(type: string): boolean {
  return (
    type === "ftyp" ||
    type === "styp" ||
    type === "moov" ||
    type === "moof" ||
    type === "mdat" ||
    type === "free" ||
    type === "skip" ||
    type === "wide" ||
    type === "junk" ||
    type === "pnot" ||
    type === "uuid" ||
    type === "sidx" ||
    type === "emsg" ||
    type === "meta"
  );
}

/** True when the first bytes cannot be a playable file of this container. */
export function isCorruptMediaHead(
  input: Uint8Array | ArrayBuffer | null | undefined,
  mimeType: string | null | undefined,
): boolean {
  if (!input) return false;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) return true;

  // A real media container never starts with a zero-filled header. This is the
  // signature of a sparse/incomplete upload and is worth rejecting even when
  // we cannot identify the exact container.
  if (bytes.every((value) => value === 0)) return true;

  const mime = String(mimeType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (
    mime === "video/mp4" ||
    mime === "video/x-m4v" ||
    mime === "video/quicktime" ||
    mime === "audio/mp4"
  ) {
    if (bytes.length < 12) return false;
    const boxSize =
      bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3];
    const boxType = ascii(bytes, 4, 4);
    // ISO BMFF boxes use a 32-bit size followed by a fourcc. A valid first box
    // has a size of at least 8 (size 1 means a 64-bit extended size follows).
    // Some QuickTime files start with moov/mdat/wide or a filler box.
    return !((boxSize >= 8 || boxSize === 1) && isMp4BoxType(boxType));
  }

  if (mime === "video/webm") {
    return !(
      bytes.length >= 4 &&
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    );
  }

  if (mime === "video/ogg" || mime === "audio/ogg" || mime === "audio/opus") {
    return ascii(bytes, 0, 4) !== "OggS";
  }

  if (mime === "audio/mpeg") {
    if (ascii(bytes, 0, 3) === "ID3") return false;
    return !(bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  }

  if (mime === "audio/flac") {
    return ascii(bytes, 0, 4) !== "fLaC";
  }

  if (mime === "audio/wav") {
    return !(ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE");
  }

  if (mime === "audio/aac") {
    return !(bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0);
  }

  return false;
}
