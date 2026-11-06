import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceId } from "@/app/lib/sessionAuth";

/**
 * Same-origin MEGA API gateway.
 *
 * The browser-side cloud player needs MEGA's small JSON metadata/download-URL
 * API (`/cs`). Calling it cross-origin works in Chromium, but browsers that add
 * cache headers (`Pragma`/`Cache-Control`) or extensions that do so can fail the
 * CORS preflight because MEGA only allows Content-Type, X-Hashcash and
 * MEGA-Chrome-Antileak.
 *
 * This route forwards only that JSON API call. Media ranges are still fetched
 * directly from MEGA by the browser; no file bytes pass through Next.js.
 */

const MEGA_API_ORIGIN = "https://g.api.mega.co.nz";
const MEGA_USER_AGENT = "StreamLift (+https://streamlift.app)";
const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_ACTIONS = new Set(["g", "f"]);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json(
    { success: false, error: code, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function readBody(req: NextRequest): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const body = await req.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return null;
  return body;
}

function validateApiBody(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  return parsed.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const action = (entry as { a?: unknown }).a;
    return typeof action === "string" && ALLOWED_ACTIONS.has(action);
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const auth = await requireWorkspaceId(req);
  if (!auth.ok) return auth.response;

  const segments = (await params).path ?? [];
  if (segments.length !== 1 || segments[0] !== "cs") {
    return jsonError(404, "not_found", "Unknown cloud API endpoint");
  }

  const body = await readBody(req);
  if (body === null) {
    return jsonError(413, "too_large", "Cloud API request is too large");
  }
  if (!validateApiBody(body)) {
    return jsonError(400, "bad_request", "Invalid cloud API request");
  }

  const upstream = new URL("/cs", MEGA_API_ORIGIN);
  req.nextUrl.searchParams.forEach((value, key) => {
    // This gateway is only for anonymous public share links. Do not let a
    // caller tunnel a MEGA account session (`sid`) through the server.
    if (key !== "sid") upstream.searchParams.set(key, value);
  });

  const headers = new Headers({
    "Content-Type": "application/json",
    "User-Agent": MEGA_USER_AGENT,
  });
  const hashcash = req.headers.get("x-hashcash");
  if (hashcash) headers.set("X-Hashcash", hashcash);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(upstream, {
      method: "POST",
      headers,
      body,
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();

    const responseHeaders = new Headers();
    responseHeaders.set(
      "Content-Type",
      response.headers.get("content-type") ?? "application/json",
    );
    responseHeaders.set("Cache-Control", "no-store");
    for (const name of ["x-hashcash", "x-mega-time-left"]) {
      const value = response.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("[mega-gateway] upstream request failed", error);
    return jsonError(502, "upstream", "Cloud metadata service unavailable");
  } finally {
    clearTimeout(timer);
  }
}
