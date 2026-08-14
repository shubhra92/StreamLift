/**
 * POST /api/worker/logs
 * Worker flushes its log queue here. We accept and discard in v2 —
 * live logs are now streamed directly from the worker's /stream SSE endpoint.
 * Kept for backward-compat so older worker versions don't get 404s.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }

  const { workerId, authToken } = body ?? {};

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing credentials" }, { status: 401 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  // Logs accepted but not stored — client gets live logs from worker SSE directly
  return NextResponse.json({ success: true, message: "Logs received" });
}
