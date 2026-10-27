/**
 * /api/worker/[workerId]/proxy/[...path] — streaming same-origin worker proxy.
 *
 * Free tunnl.gg tunnels redirect browser-user-agent OPTIONS requests to their
 * warning page before the worker's CORS middleware can answer. A browser
 * cannot attach `tunnl-skip-browser-warning` to a preflight, so the web client
 * sends worker traffic here instead. This route adds the bypass header and the
 * worker session token server-side, then streams the upstream response back
 * unchanged (SSE, HLS playlists/segments, Range downloads, JSON).
 *
 * The proxy is deliberately limited to `*.tunnl.gg`. Other providers (zrok,
 * Pinggy, Serveo) keep the direct browser-to-worker path so media bytes do not
 * consume Next.js bandwidth.
 *
 * The worker heartbeat is intentionally NOT checked per request. A download or
 * HLS stream that is already running must not be cut because a later request
 * arrived while the heartbeat was briefly stale.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";
import { getTunnelBypassHeaders, requiresSameOriginProxy } from "@/app/lib/tunnelHeaders";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Fail fast when a dead tunnel never sends response headers. */
const HEADER_TIMEOUT_MS = 20_000;

/** Worker request bodies are tiny JSON payloads; cap them defensively. */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "DELETE"]);

/**
 * Worker API roots the browser is allowed to reach. The worker's `/internal/*`
 * control surface is intentionally absent, as are any future private roots.
 */
const ALLOWED_ROOT_SEGMENTS = new Set([
  "health",
  "status",
  "stream",
  "download",
  "downloads",
  "media",
  "watch",
  "file-info",
  "torrent-metadata",
  "browser-download",
]);

/** Only headers the worker actually needs are forwarded. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "last-event-id",
  "range",
] as const;

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

class RequestBodyTooLargeError extends Error {}

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json(
    { success: false, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** Build a safe worker path from Next.js' catch-all segments. */
function buildWorkerPath(segments: string[]): string | null {
  if (segments.length === 0) return null;

  const normalized: string[] = [];
  for (const raw of segments) {
    let segment: string;
    try {
      // Next decodes dynamic params; decode again so double-encoded traversal
      // (`%252e%252e`) is caught instead of reaching the tunnel.
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }

    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(segment)
    ) {
      return null;
    }
    normalized.push(segment);
  }

  if (!ALLOWED_ROOT_SEGMENTS.has(normalized[0])) return null;
  return "/" + normalized.map((segment) => encodeURIComponent(segment)).join("/");
}

async function readRequestBody(req: NextRequest): Promise<ArrayBuffer | undefined> {
  const declared = req.headers.get("content-length");
  if (declared) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
  }

  if (!req.body) return undefined;

  const buffer = await req.arrayBuffer();
  if (buffer.byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError();
  }
  return buffer.byteLength > 0 ? buffer : undefined;
}

function copyResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  const contentEncoding = upstream.headers.get("content-encoding");
  // undici transparently decompresses gzip/br bodies but keeps the compressed
  // Content-Encoding/Content-Length headers. Forwarding those would truncate
  // or corrupt the response, so drop both when the upstream was encoded.
  const isEncoded = Boolean(
    contentEncoding && contentEncoding.toLowerCase() !== "identity",
  );

  upstream.headers.forEach((value, key) => {
    const name = key.toLowerCase();

    if (HOP_BY_HOP_RESPONSE_HEADERS.has(name)) return;
    if (name === "set-cookie") return;
    if (isEncoded && (name === "content-encoding" || name === "content-length")) return;

    headers.set(key, value);
  });

  return headers;
}

type RouteContext = {
  params: Promise<{ workerId: string; path: string[] }>;
};

async function handler(req: NextRequest, { params }: RouteContext): Promise<Response> {
  // Auth — the raw tunnel URL is a per-worker secret, but this route must not
  // become an unauthenticated open proxy either.
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
  if (!token) return jsonError("Unauthorized", 401);

  const guest = await validateGuestToken(token);
  if (!guest) return jsonError("Unauthorized", 401);

  const { workerId, path: rawPath } = await params;

  const method = req.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return jsonError("Method not allowed", 405);
  }

  const workerPath = buildWorkerPath(rawPath);
  if (!workerPath) return jsonError("Not found", 404);

  const [worker] = await db
    .select()
    .from(workers)
    .where(eq(workers.id, workerId))
    .limit(1);

  if (!worker || worker.guestId !== guest.id) {
    return jsonError("Worker not found", 404);
  }

  if (!worker.tunnelUrl) {
    return jsonError("Worker is offline — no tunnel URL available", 503);
  }

  let tunnel: URL;
  try {
    tunnel = new URL(worker.tunnelUrl);
  } catch {
    return jsonError("Worker tunnel URL is invalid", 503);
  }

  if (tunnel.protocol !== "https:") {
    return jsonError("Worker tunnel is not HTTPS", 503);
  }

  // Keep other tunnel providers direct — the proxy exists only to work around
  // tunnl.gg's preflight redirect.
  if (!requiresSameOriginProxy(worker.tunnelUrl)) {
    return jsonError("Worker does not use the same-origin proxy", 404);
  }

  const proxyBase = `/api/worker/${encodeURIComponent(workerId)}/proxy`;
  const upstreamUrl =
    `${worker.tunnelUrl.replace(/\/+$/, "")}${workerPath}${req.nextUrl.search}`;

  // Build upstream headers. Never forward the guest cookie, browser Origin/
  // Referer, or a client-supplied session token.
  const upstreamHeaders = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) upstreamHeaders.set(name, value);
  }

  // Ask for an identity body so Content-Length stays valid, and present a
  // non-browser user agent so tunnl.gg's daily warning page is not triggered.
  upstreamHeaders.set("Accept-Encoding", "identity");
  upstreamHeaders.set("User-Agent", "StreamLift-Proxy/1.0 (+https://streamlift.app)");

  for (const [name, value] of Object.entries(getTunnelBypassHeaders(worker.tunnelUrl))) {
    upstreamHeaders.set(name, value);
  }

  // The raw-file endpoint prefers X-Session-Token over ?download_token when
  // both are present. A playback ticket stays valid across a session-token
  // expiry, so let the ticket authenticate that request instead of injecting
  // a token that may have gone stale mid-playback.
  const usesDownloadTicket = req.nextUrl.searchParams.has("download_token");
  if (worker.sessionToken && !usesDownloadTicket) {
    upstreamHeaders.set("X-Session-Token", worker.sessionToken);
  }

  let requestBody: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    try {
      requestBody = await readRequestBody(req);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return jsonError("Request body too large", 413);
      }
      throw error;
    }
  }

  const controller = new AbortController();
  const abortFromClient = () => controller.abort();
  if (req.signal.aborted) {
    abortFromClient();
  } else {
    req.signal.addEventListener("abort", abortFromClient, { once: true });
  }

  const headerTimer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers: upstreamHeaders,
      body: requestBody,
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error: any) {
    if (req.signal.aborted) return new Response(null, { status: 499 });

    const timedOut = error?.name === "AbortError";
    console.error(
      `[worker-proxy] ${method} ${workerPath} failed:`,
      error?.message ?? error,
    );
    return jsonError(
      timedOut
        ? "Worker tunnel did not respond in time"
        : "Could not reach the worker tunnel",
      timedOut ? 504 : 502,
    );
  } finally {
    clearTimeout(headerTimer);
  }

  // Same-tunnel redirects (e.g. tunnl.gg's HTTP download hand-off) are
  // rewritten back through the proxy; a redirect to the provider's warning
  // page is an error the client should see explicitly.
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("location");
    if (location) {
      try {
        const target = new URL(location, upstreamUrl);
        if (target.hostname.toLowerCase() === tunnel.hostname.toLowerCase()) {
          const proxiedPath =
            `${proxyBase}${target.pathname}${target.search}${target.hash}`;
          const headers = new Headers();
          headers.set(
            "Location",
            new URL(proxiedPath, req.nextUrl.origin).toString(),
          );
          headers.set("Cache-Control", "no-store");
          return new Response(null, { status: upstream.status, headers });
        }
      } catch {
        // Malformed Location — handled as an unexpected redirect below.
      }
    }

    await upstream.body?.cancel().catch(() => undefined);
    return jsonError("Worker tunnel returned an unexpected redirect", 502);
  }

  const contentType = upstream.headers.get("content-type") ?? "";

  // Worker endpoints never return HTML. A 2xx/4xx HTML body here means
  // tunnl.gg served its warning page instead of proxying to the worker.
  if (upstream.ok && contentType.includes("text/html")) {
    await upstream.body?.cancel().catch(() => undefined);
    return jsonError(
      "Worker tunnel returned an interstitial page instead of worker data",
      502,
    );
  }

  const responseHeaders = copyResponseHeaders(upstream);

  // SSE must stay unbuffered and must never carry stale compression/length
  // headers. The client reads it with fetch(), not EventSource.
  if (contentType.includes("text/event-stream")) {
    responseHeaders.set("Content-Type", "text/event-stream; charset=utf-8");
    responseHeaders.set("Cache-Control", "no-cache, no-transform");
    responseHeaders.set("X-Accel-Buffering", "no");
    responseHeaders.set("Connection", "keep-alive");
    responseHeaders.delete("Content-Length");
    responseHeaders.delete("Content-Encoding");
  }

  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export { handler as GET, handler as HEAD, handler as POST, handler as DELETE };
