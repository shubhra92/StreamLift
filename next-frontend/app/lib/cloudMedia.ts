"use client";

import { getMediaMime } from "./media";
import { isCorruptMediaHead } from "./mediaHead";

const MEGA_API_GATEWAY_PATH = "/api/cloud/mega-gateway/";
const HEAD_PROBE_BYTES = 64;
const HEAD_PROBE_TIMEOUT_MS = 15_000;

export interface CloudBlobDownload {
  promise: Promise<Blob>;
  cancel: () => void;
}

/**
 * megajs destroy() can leave its detached reader pump rejecting with an
 * "aborted" error that has no catch. Swallow only that specific rejection while
 * the destroy settles, matching downloadCloudFileToDisk's guard.
 */
function destroyMegajsStream(stream: any): void {
  if (!stream || typeof window === "undefined") return;
  const handler = (event: PromiseRejectionEvent) => {
    const reason: any = event?.reason;
    const message = typeof reason?.message === "string" ? reason.message : String(reason ?? "");
    if (/aborted/i.test(message)) event.preventDefault();
  };
  window.addEventListener("unhandledrejection", handler);
  try {
    stream.destroy?.();
  } catch {
    /* already gone */
  }
  window.setTimeout(() => window.removeEventListener("unhandledrejection", handler), 500);
}

function concatHead(chunks: Uint8Array[], maxBytes: number): Uint8Array {
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

function readMegaHead(
  file: any,
  maxBytes: number,
  setActiveStream: (stream: any) => void,
  isCancelled: () => boolean,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: number | undefined;
    let stream: any = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) window.clearTimeout(timer);
      fn();
    };

    try {
      stream = file.download({ start: 0, end: maxBytes - 1, maxConnections: 1 });
      setActiveStream(stream);
      if (isCancelled()) {
        destroyMegajsStream(stream);
        reject(new DOMException("Canceled", "AbortError"));
        return;
      }
    } catch (error) {
      reject(error);
      return;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    timer = window.setTimeout(() => {
      finish(() => {
        destroyMegajsStream(stream);
        reject(new Error("Timed out reading cloud file header"));
      });
    }, HEAD_PROBE_TIMEOUT_MS);

    stream.on("data", (chunk: Uint8Array) => {
      if (settled || isCancelled()) return;
      const bytes = new Uint8Array(chunk);
      const room = maxBytes - total;
      if (room <= 0) return;
      const take = Math.min(room, bytes.length);
      chunks.push(bytes.subarray(0, take));
      total += take;
    });
    stream.on("end", () => finish(() => resolve(concatHead(chunks, maxBytes))));
    stream.on("error", (error: Error) => finish(() => reject(error)));
  });
}

/**
 * Download and decrypt a whole cloud file in the browser, then return it as a
 * Blob. Used only as a fallback when the service-worker range stream cannot be
 * used (Safari media-range quirks, unsupported SW, etc.).
 *
 * This buffers the entire file, so the caller should warn for very large files.
 */
export function downloadCloudFileToBlob(
  sourceUrl: string,
  mimeType: string | null | undefined,
  onProgress?: (receivedBytes: number, totalBytes: number) => void,
): CloudBlobDownload {
  let cancelled = false;
  let stream: any = null;

  const promise = (async () => {
    const { File: MegaFile, API: MegaApi } = await import("megajs");
    const api = new MegaApi(false, {
      gateway: `${window.location.origin}${MEGA_API_GATEWAY_PATH}`,
    });
    const file = MegaFile.fromURL(sourceUrl, { api });
    await file.loadAttributes();

    if (cancelled) throw new DOMException("Canceled", "AbortError");

    const totalBytes = typeof file.size === "number" ? file.size : 0;
    const nameMime = getMediaMime(file.name ?? "");
    const resolvedMime =
      mimeType && mimeType !== "application/octet-stream" ? mimeType : nameMime;

    // Catch a sparse/incomplete cloud upload before buffering the whole file.
    if (totalBytes > 0) {
      const headBytes = Math.min(HEAD_PROBE_BYTES, totalBytes);
      let head: Uint8Array | null = null;
      try {
        head = await readMegaHead(file, headBytes, (active) => {
          stream = active;
        }, () => cancelled);
      } catch {
        if (cancelled) throw new DOMException("Canceled", "AbortError");
        // A failed probe must not block the fallback; the full download (and
        // the player) will report the real problem.
        head = null;
      }
      if (cancelled) throw new DOMException("Canceled", "AbortError");
      if (head && isCorruptMediaHead(head, resolvedMime)) {
        throw new Error(
          "This cloud file appears incomplete or corrupt. Re-upload it from the worker and try again.",
        );
      }
    }

    const chunks: ArrayBuffer[] = [];
    let receivedBytes = 0;

    if (cancelled) throw new DOMException("Canceled", "AbortError");
    stream = file.download({ maxConnections: 1 });
    if (cancelled) {
      destroyMegajsStream(stream);
      throw new DOMException("Canceled", "AbortError");
    }

    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Uint8Array) => {
        if (cancelled) return;
        const bytes = new Uint8Array(chunk.byteLength);
        bytes.set(chunk);
        chunks.push(bytes.buffer);
        receivedBytes += bytes.length;
        onProgress?.(receivedBytes, totalBytes);
      });
      stream.on("end", () => resolve());
      stream.on("error", (error: Error) => reject(error));
    });

    if (cancelled) throw new DOMException("Canceled", "AbortError");

    return new Blob(chunks, { type: resolvedMime || "application/octet-stream" });
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      destroyMegajsStream(stream);
    },
  };
}
