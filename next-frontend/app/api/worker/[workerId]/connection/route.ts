/**
 * GET /api/worker/[workerId]/connection
 *
 * Returns { pinggyUrl, sessionToken } so the client can call the worker API directly.
 * Auto-rotates the session token if it's expired or missing.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";
import { isSessionTokenExpired, rotateSessionToken } from "@/app/lib/sessionToken";
import { clearStaleWorkerConnections, isWorkerOnline } from "@/app/lib/workerPresence";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> },
) {
  // Auth — only the owning guest can get connection details
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
  const guest = await validateGuestToken(token);
  if (!guest) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  await clearStaleWorkerConnections(guest.id);

  const { workerId } = await params;

  const [worker] = await db
    .select()
    .from(workers)
    .where(eq(workers.id, workerId))
    .limit(1);

  if (!worker || worker.guestId !== guest.id) {
    return NextResponse.json({ success: false, message: "Worker not found" }, { status: 404 });
  }

  if (!worker.pinggyUrl) {
    return NextResponse.json(
      { success: false, message: "Worker is offline — no tunnel URL available" },
      { status: 503 },
    );
  }

  if (!worker.pinggyUrl.startsWith("https://")) {
    return NextResponse.json(
      { success: false, message: "Worker tunnel is not HTTPS. Restart the worker to obtain a secure Pinggy URL." },
      { status: 503 },
    );
  }

  // Check online status — last heartbeat must be within 20 seconds
  const isOnline = isWorkerOnline(worker.lastHeartbeat);

  if (!isOnline) {
    return NextResponse.json(
      { success: false, message: "Worker is offline" },
      { status: 503 },
    );
  }

  // Auto-rotate session token if expired
  let sessionToken = worker.sessionToken;
  if (isSessionTokenExpired(worker.sessionTokenExpiry)) {
    try {
      sessionToken = await rotateSessionToken(workerId, worker.pinggyUrl, worker.authToken);
    } catch (e: any) {
      return NextResponse.json(
        { success: false, message: `Failed to refresh session token: ${e.message}` },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({
    success:      true,
    pinggyUrl:    worker.pinggyUrl,
    sessionToken,
  });
}
