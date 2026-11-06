/* eslint-disable no-undef */
/**
 * Cloud-media service worker.
 *
 * The media element asks for /__mega-stream/<watchItemId>. This worker looks up
 * the item registered by the page, fetches only the requested byte range from
 * the provider, decrypts it with megajs, and returns a normal 206 response.
 *
 * Media bytes never pass through the Next.js server.
 */

const STREAM_PREFIX = "/__mega-stream/";
const MEGA_VENDOR = "/vendor/megajs.browser-umd.js";
const MEGA_API_GATEWAY = `${self.location.origin}/api/cloud/mega-gateway/`;
const HEAD_PROBE_BYTES = 64;
const HEAD_PROBE_TIMEOUT_MS = 15_000;

const MIME_TYPES = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
};

importScripts(MEGA_VENDOR);

const Mega =
  self.mega || (typeof mega !== "undefined" ? mega : null); // eslint-disable-line no-use-before-define

/** id -> { provider, playbackMode, sourceUrl, name, size } */
const streams = new Map();
/** sourceUrl -> Promise<File> */
const attributeCache = new Map();
/** sourceUrl -> Promise<{ ok: boolean, reason: string | null }> */
const integrityCache = new Map();
let megaApi = null;

/**
 * Route megajs's JSON API calls through our same-origin gateway so browsers
 * that add non-safelisted cache headers never have to pass a CORS preflight.
 * media bytes still come straight from MEGA's storage hosts.
 */
function getMegaApi() {
  if (!Mega || !Mega.API) return null;
  if (!megaApi) {
    megaApi = new Mega.API(false, { gateway: MEGA_API_GATEWAY });
  }
  return megaApi;
}

// megajs destroy() may leave an uncaught "aborted" rejection behind. It is
// expected when a media request is cancelled, so keep it out of the console.
self.addEventListener("unhandledrejection", (event) => {
  const message = String(event?.reason?.message ?? event?.reason ?? "");
  if (/aborted/i.test(message)) event.preventDefault();
});

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "register-watch-stream") {
    if (typeof data.id !== "string" || typeof data.sourceUrl !== "string") return;
    streams.set(data.id, {
      provider: data.provider || "mega",
      playbackMode: data.playbackMode || "mega-share",
      sourceUrl: data.sourceUrl,
      name: data.name || "media",
      size: typeof data.size === "number" ? data.size : 0,
      mimeType: typeof data.mimeType === "string" ? data.mimeType : "",
    });
    event.ports[0]?.postMessage({ type: "watch-stream-registered", id: data.id });
    return;
  }

  if (data.type === "unregister-watch-stream" && typeof data.id === "string") {
    streams.delete(data.id);
  }
});

self.addEventListener("fetch", (event) => {
  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(STREAM_PREFIX)) return;

  const id = decodeURIComponent(url.pathname.slice(STREAM_PREFIX.length).split("/")[0] || "");
  event.respondWith(handleStream(event.request, id));
});

async function handleStream(request, id) {
  const meta = streams.get(id);
  if (!meta) {
    return errorResponse(404, "This Watch item is not registered with the stream worker.", "not-registered");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "Only GET and HEAD are supported.", "method-not-allowed");
  }

  try {
    if (meta.playbackMode === "mega-share" || meta.provider === "mega") {
      return await handleMegaStream(request, meta);
    }
    if (meta.playbackMode === "direct") {
      return await handleDirectStream(request, meta);
    }
    return errorResponse(400, "Unsupported playback mode.", "unsupported");
  } catch (error) {
    const message = String(error?.message ?? error ?? "");
    if (/quota|509|bandwidth|transfer/i.test(message)) {
      return errorResponse(429, "Cloud transfer quota exceeded.", "quota");
    }
    if (/ENOENT|not found|Node.*not found|\(-9\)/i.test(message)) {
      return errorResponse(404, "File not found in cloud storage.", "not-found");
    }
    return errorResponse(502, "Cloud stream failed.", "upstream");
  }
}

async function loadMegaFile(meta) {
  if (!Mega || !Mega.File) throw new Error("MEGA playback adapter unavailable");

  const cached = attributeCache.get(meta.sourceUrl);
  if (cached) return cached;

  const promise = (async () => {
    const api = getMegaApi();
    const file = api
      ? Mega.File.fromURL(meta.sourceUrl, { api })
      : Mega.File.fromURL(meta.sourceUrl);
    await file.loadAttributes();
    return file;
  })();

  attributeCache.set(meta.sourceUrl, promise);
  try {
    return await promise;
  } catch (error) {
    attributeCache.delete(meta.sourceUrl);
    throw error;
  }
}

async function handleMegaStream(request, meta) {
  const file = await loadMegaFile(meta);
  const size = typeof file.size === "number" && file.size > 0 ? file.size : meta.size;

  if (!size || size <= 0) {
    return errorResponse(404, "Cloud file has no readable size.", "not-found");
  }

  const range = parseRange(request.headers.get("range"), size);
  if (range.status === 416) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }

  // Fail fast on zero-filled/sparse uploads instead of letting the media
  // element download hundreds of megabytes before reporting DEMUXER_ERROR.
  // A transient failure while reading the head should not block playback; the
  // real range request will surface the upstream error.
  let integrity = { ok: true, reason: null };
  try {
    integrity = await verifyMegaHead(file, meta, size);
  } catch {
    integrity = { ok: true, reason: null };
  }
  if (!integrity.ok) {
    return errorResponse(
      422,
      "This cloud file appears incomplete or corrupt. Re-upload it from the worker and try again.",
      "corrupt",
    );
  }

  const headers = buildHeaders(meta, size, range);
  if (request.method === "HEAD") {
    return new Response(null, { status: range.status, headers });
  }

  const stream = file.download({
    start: range.start,
    end: range.end,
    maxConnections: 1,
  });

  let closed = false;
  const body = new ReadableStream({
    start(controller) {
      const fail = (error) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(error);
        } catch {
          /* response already gone */
        }
      };

      stream.on("data", (chunk) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          return;
        }
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          try {
            stream.pause();
          } catch {
            /* stream may have ended */
          }
        }
      });
      stream.on("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      stream.on("error", fail);

      request.signal?.addEventListener("abort", () => {
        closed = true;
        try {
          stream.destroy();
        } catch {
          /* already destroyed */
        }
      });
    },
    pull() {
      if (closed) return;
      try {
        stream.resume();
      } catch {
        /* stream may have ended */
      }
    },
    cancel() {
      closed = true;
      try {
        stream.destroy();
      } catch {
        /* already destroyed */
      }
    },
  });

  return new Response(body, { status: range.status, headers });
}

function verifyMegaHead(file, meta, size) {
  const cached = integrityCache.get(meta.sourceUrl);
  if (cached) return cached;

  const promise = (async () => {
    const maxBytes = Math.min(HEAD_PROBE_BYTES, size);
    if (maxBytes <= 0) return { ok: true, reason: null };
    const bytes = await readMegaHead(file, maxBytes);
    const mime = resolveMime(meta);
    return isCorruptMediaHead(bytes, mime)
      ? { ok: false, reason: "corrupt" }
      : { ok: true, reason: null };
  })();

  integrityCache.set(meta.sourceUrl, promise);
  promise.catch(() => integrityCache.delete(meta.sourceUrl));
  return promise;
}

function readMegaHead(file, maxBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let stream;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    try {
      stream = file.download({ start: 0, end: maxBytes - 1, maxConnections: 1 });
    } catch (error) {
      reject(error);
      return;
    }

    const chunks = [];
    let total = 0;
    timer = setTimeout(() => {
      finish(() => {
        try {
          stream.destroy();
        } catch {
          /* already gone */
        }
        reject(new Error("Timed out reading cloud file header"));
      });
    }, HEAD_PROBE_TIMEOUT_MS);

    stream.on("data", (chunk) => {
      if (settled) return;
      const bytes = new Uint8Array(chunk);
      const room = maxBytes - total;
      if (room <= 0) return;
      const take = Math.min(room, bytes.length);
      chunks.push(bytes.subarray(0, take));
      total += take;
    });
    stream.on("end", () => finish(() => resolve(concatBytes(chunks, maxBytes))));
    stream.on("error", (error) => finish(() => reject(error)));
  });
}

function concatBytes(chunks, maxBytes) {
  const length = Math.min(
    maxBytes,
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= out.length) break;
  }
  return out;
}

function asciiFromBytes(bytes, offset, length) {
  if (offset < 0 || offset + length > bytes.length) return "";
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function isMp4BoxType(type) {
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

/** Keep this in sync with app/lib/mediaHead.ts. */
function isCorruptMediaHead(input, mimeType) {
  if (!input) return false;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) return true;
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
    return !(
      (boxSize >= 8 || boxSize === 1) &&
      isMp4BoxType(asciiFromBytes(bytes, 4, 4))
    );
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
    return asciiFromBytes(bytes, 0, 4) !== "OggS";
  }

  if (mime === "audio/mpeg") {
    if (asciiFromBytes(bytes, 0, 3) === "ID3") return false;
    return !(bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  }

  if (mime === "audio/flac") {
    return asciiFromBytes(bytes, 0, 4) !== "fLaC";
  }

  if (mime === "audio/wav") {
    return !(
      asciiFromBytes(bytes, 0, 4) === "RIFF" &&
      asciiFromBytes(bytes, 8, 4) === "WAVE"
    );
  }

  if (mime === "audio/aac") {
    return !(bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0);
  }

  return false;
}

async function handleDirectStream(request, meta) {
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("Range", range);

  const response = await fetch(meta.sourceUrl, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers,
    cache: "no-store",
  });

  return response;
}

function parseRange(header, size) {
  if (!header) return { status: 200, start: 0, end: size - 1 };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { status: 200, start: 0, end: size - 1 };

  let start;
  let end;

  if (match[1] === "") {
    if (match[2] === "") return { status: 416, start: 0, end: -1 };
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return { status: 416, start: 0, end: -1 };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(size - 1, Number(match[2]));
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return { status: 416, start: 0, end: -1 };
  }

  return { status: 206, start, end };
}

function buildHeaders(meta, size, range) {
  const headers = new Headers();
  headers.set("Content-Type", resolveMime(meta));
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Cloud-File-Size", String(size));

  if (range.status === 206) {
    headers.set("Content-Length", String(range.end - range.start + 1));
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  } else {
    headers.set("Content-Length", String(size));
  }

  return headers;
}

function resolveMime(meta) {
  const stored = String(meta.mimeType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (stored && stored !== "application/octet-stream") return stored;
  return mimeType(meta.name);
}

function mimeType(name) {
  const base = String(name || "").split(/[?#]/)[0];
  const dot = base.lastIndexOf(".");
  const extension = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  return MIME_TYPES[extension] || "application/octet-stream";
}

function errorResponse(status, message, code) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-StreamLift-Error": code,
    },
  });
}
