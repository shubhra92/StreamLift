/**
 * Pure browser-side .torrent parser.
 * No npm dependencies — uses SubtleCrypto (Web Crypto API) for SHA-1
 * and a hand-rolled bencode decoder.
 */

// ---------------------------------------------------------------------------
// Bencode decoder
// ---------------------------------------------------------------------------

type BencodeValue = number | Uint8Array | BencodeValue[] | { [key: string]: BencodeValue };

function decodeBencode(buf: Uint8Array, offset = 0): { value: BencodeValue; end: number } {
  const byte = buf[offset];

  // Integer: i<number>e
  if (byte === 0x69 /* 'i' */) {
    const end = buf.indexOf(0x65 /* 'e' */, offset + 1);
    const value = parseInt(new TextDecoder().decode(buf.slice(offset + 1, end)), 10);
    return { value, end: end + 1 };
  }

  // List: l...e
  if (byte === 0x6c /* 'l' */) {
    const list: BencodeValue[] = [];
    let pos = offset + 1;
    while (buf[pos] !== 0x65 /* 'e' */) {
      const item = decodeBencode(buf, pos);
      list.push(item.value);
      pos = item.end;
    }
    return { value: list, end: pos + 1 };
  }

  // Dictionary: d...e
  if (byte === 0x64 /* 'd' */) {
    const dict: { [key: string]: BencodeValue } = {};
    let pos = offset + 1;
    while (buf[pos] !== 0x65 /* 'e' */) {
      const keyItem = decodeBencode(buf, pos);
      pos = keyItem.end;
      const valItem = decodeBencode(buf, pos);
      pos = valItem.end;
      const key = new TextDecoder().decode(keyItem.value as Uint8Array);
      dict[key] = valItem.value;
    }
    return { value: dict, end: pos + 1 };
  }

  // Byte string: <length>:<bytes>
  const colonIdx = buf.indexOf(0x3a /* ':' */, offset);
  const length = parseInt(new TextDecoder().decode(buf.slice(offset, colonIdx)), 10);
  const start = colonIdx + 1;
  return { value: buf.slice(start, start + length), end: start + length };
}

// ---------------------------------------------------------------------------
// Re-encode a decoded value back to bencode bytes
// (needed to hash the info dict exactly as it appears in the file)
// ---------------------------------------------------------------------------

function encodeBencode(value: BencodeValue): Uint8Array {
  const enc = new TextEncoder();

  if (value instanceof Uint8Array) {
    const prefix = enc.encode(`${value.byteLength}:`);
    const out = new Uint8Array(prefix.byteLength + value.byteLength);
    out.set(prefix);
    out.set(value, prefix.byteLength);
    return out;
  }

  if (typeof value === "number") {
    return enc.encode(`i${value}e`);
  }

  if (Array.isArray(value)) {
    const parts = value.map(encodeBencode);
    const total = parts.reduce((s, p) => s + p.byteLength, 2);
    const out = new Uint8Array(total);
    out[0] = 0x6c; // 'l'
    let pos = 1;
    for (const p of parts) { out.set(p, pos); pos += p.byteLength; }
    out[pos] = 0x65; // 'e'
    return out;
  }

  // dict — keys must be sorted
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => {
    const keyBytes = enc.encode(k);
    const keyEncoded = encodeBencode(keyBytes);
    const valEncoded = encodeBencode((value as { [key: string]: BencodeValue })[k]);
    const combined = new Uint8Array(keyEncoded.byteLength + valEncoded.byteLength);
    combined.set(keyEncoded);
    combined.set(valEncoded, keyEncoded.byteLength);
    return combined;
  });

  const total = parts.reduce((s, p) => s + p.byteLength, 2);
  const out = new Uint8Array(total);
  out[0] = 0x64; // 'd'
  let pos = 1;
  for (const p of parts) { out.set(p, pos); pos += p.byteLength; }
  out[pos] = 0x65; // 'e'
  return out;
}

// ---------------------------------------------------------------------------
// SHA-1 via Web Crypto
// ---------------------------------------------------------------------------

async function sha1Hex(buf: Uint8Array): Promise<string> {
  // crypto.subtle.digest requires a plain ArrayBuffer (not ArrayBufferLike)
  const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const hashBuf = await crypto.subtle.digest("SHA-1", arrayBuf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// File type detection
// ---------------------------------------------------------------------------

function detectFileType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v"].includes(ext)) return "video";
  if (["mp3", "flac", "aac", "ogg", "wav", "m4a", "wma"].includes(ext)) return "audio";
  if (["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "tiff"].includes(ext)) return "image";
  if (["pdf", "doc", "docx", "txt", "epub", "mobi"].includes(ext)) return "document";
  if (["zip", "rar", "7z", "tar", "gz", "bz2"].includes(ext)) return "archive";
  return "other";
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParsedTorrentFile {
  index: number;
  name: string;
  path: string;
  size: number;
  sizeFormatted: string;
  type: string;
}

export interface ParsedTorrent {
  name: string;
  infoHash: string;
  magnetLink: string;
  totalSize: number;
  totalSizeFormatted: string;
  files: ParsedTorrentFile[];
  fileCount: number;
}

export async function parseTorrentFile(file: File): Promise<ParsedTorrent> {
  const arrayBuffer = await file.arrayBuffer();
  const buf = new Uint8Array(arrayBuffer);

  const { value: torrent } = decodeBencode(buf);
  const torrentDict = torrent as { [key: string]: BencodeValue };
  const info = torrentDict["info"] as { [key: string]: BencodeValue };

  // Hash the re-encoded info dict
  const infoEncoded = encodeBencode(info);
  const infoHash = await sha1Hex(infoEncoded);

  // Torrent name
  const name = info["name"] instanceof Uint8Array
    ? new TextDecoder("utf-8").decode(info["name"])
    : "unknown";

  // Trackers
  const trackers: string[] = [];
  if (Array.isArray(torrentDict["announce-list"])) {
    for (const tier of torrentDict["announce-list"] as BencodeValue[][]) {
      for (const t of tier) {
        if (t instanceof Uint8Array) trackers.push(new TextDecoder().decode(t));
      }
    }
  } else if (torrentDict["announce"] instanceof Uint8Array) {
    trackers.push(new TextDecoder().decode(torrentDict["announce"]));
  }

  // Build magnet link
  let magnetLink = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}`;
  for (const tr of trackers) magnetLink += `&tr=${encodeURIComponent(tr)}`;

  // Files list
  const files: ParsedTorrentFile[] = [];

  if (Array.isArray(info["files"])) {
    // Multi-file torrent
    let idx = 0;
    for (const f of info["files"] as { [key: string]: BencodeValue }[]) {
      const pathParts = (f["path"] as Uint8Array[]).map((p) =>
        new TextDecoder("utf-8").decode(p)
      );
      const filePath = [name, ...pathParts].join("/");
      const fileName = pathParts[pathParts.length - 1];
      const size = f["length"] as number;
      files.push({
        index: idx++,
        name: fileName,
        path: filePath,
        size,
        sizeFormatted: formatBytes(size),
        type: detectFileType(fileName),
      });
    }
  } else {
    // Single-file torrent
    const size = info["length"] as number;
    files.push({
      index: 0,
      name,
      path: name,
      size,
      sizeFormatted: formatBytes(size),
      type: detectFileType(name),
    });
  }

  const totalSize = files.reduce((s, f) => s + f.size, 0);

  return {
    name,
    infoHash,
    magnetLink,
    totalSize,
    totalSizeFormatted: formatBytes(totalSize),
    files,
    fileCount: files.length,
  };
}
