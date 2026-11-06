"use client";

import type { WatchItemDto } from "./watchTypes";

const SERVICE_WORKER_PATH = "/mega-stream-sw.js?v=2";
const STREAM_PREFIX = "/__mega-stream";

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

/** Virtual same-origin URL the media element points at. */
export function cloudStreamUrl(id: string): string {
  return `${STREAM_PREFIX}/${encodeURIComponent(id)}`;
}

export function isCloudStreamUrl(url: string): boolean {
  return url.startsWith(`${STREAM_PREFIX}/`);
}

/**
 * Register the cloud-media service worker and wait until it controls this page.
 *
 * The first visit after registration needs a `controllerchange` before media
 * requests are intercepted, hence the short wait.
 */
export async function ensureWatchStreamWorker(): Promise<boolean> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return false;

  if (!registrationPromise) {
    registrationPromise = navigator.serviceWorker
      .register(SERVICE_WORKER_PATH, { scope: "/" })
      .catch(() => {
        // Allow a later attempt (e.g. after the user comes back online).
        registrationPromise = null;
        return null;
      });
  }

  const registration = await registrationPromise;
  if (!registration) return false;

  try {
    await navigator.serviceWorker.ready;
  } catch {
    return false;
  }

  if (navigator.serviceWorker.controller?.scriptURL.includes("v=2")) return true;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", finish);
      resolve();
    };
    navigator.serviceWorker.addEventListener("controllerchange", finish);
    window.setTimeout(finish, 3_000);
  });

  return Boolean(navigator.serviceWorker.controller);
}

/** Hand the share URL/metadata to the service worker for one Watch item. */
export async function registerWatchStream(
  item: Pick<
    WatchItemDto,
    "id" | "provider" | "playbackMode" | "sourceUrl" | "name" | "fileSize" | "mimeType"
  >,
): Promise<boolean> {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return false;

  return new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => resolve(false), 1_500);

    channel.port1.onmessage = (event) => {
      if (event.data?.type !== "watch-stream-registered") return;
      window.clearTimeout(timer);
      resolve(true);
    };

    controller.postMessage(
      {
        type: "register-watch-stream",
        id: item.id,
        provider: item.provider,
        playbackMode: item.playbackMode,
        sourceUrl: item.sourceUrl,
        name: item.name,
        size: item.fileSize ?? 0,
        mimeType: item.mimeType ?? "",
      },
      [channel.port2],
    );
  });
}

export function unregisterWatchStream(id: string): void {
  navigator.serviceWorker?.controller?.postMessage({
    type: "unregister-watch-stream",
    id,
  });
}

export interface WatchStreamProbe {
  ok: boolean;
  status: number;
  size: number | null;
  error: string | null;
}

/**
 * HEAD the virtual stream URL. The service worker resolves the cloud file and
 * reports a concrete status before the player commits to a source, which lets
 * us surface "file not found"/quota errors instead of a generic media error.
 */
export async function probeWatchStream(
  id: string,
  timeoutMs = 30_000,
): Promise<WatchStreamProbe> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(cloudStreamUrl(id), {
      method: "HEAD",
      cache: "no-store",
      signal: controller.signal,
    });
    const sizeHeader = response.headers.get("x-cloud-file-size");
    return {
      ok: response.ok,
      status: response.status,
      size: sizeHeader ? Number(sizeHeader) : null,
      error: response.headers.get("x-streamlift-error"),
    };
  } catch {
    return { ok: false, status: 0, size: null, error: "network" };
  } finally {
    window.clearTimeout(timer);
  }
}
