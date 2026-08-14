/**
 * GET /api/worker/[workerId]/refresh-token
 *
 * Called by the client when it gets a 401 from the worker (token expired mid-session).
 * Rotates the session token and returns the new one.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";
import { rotateSessionToken } from "@/app/lib/sessionToken";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> },
) {
  const token = req.cookies.get(GUEST_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
  const guest = await validateGuestToken(token);
  if (!guest) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

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
      { success: false, message: "Worker has no tunnel URL — is it online?" },
      { status: 503 },
    );
  }

  try {
    const newToken = await rotateSessionToken(workerId, worker.pinggyUrl, worker.authToken);
    return NextResponse.json({ success: true, sessionToken: newToken });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, message: `Token rotation failed: ${e.message}` },
      { status: 502 },
    );
  }
}
