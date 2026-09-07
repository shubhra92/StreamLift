import { NextRequest, NextResponse } from "next/server";
import { getGuestId } from "@/app/lib/getGuestId";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { and, eq } from "drizzle-orm";
import { encryptCredentials } from "@/app/lib/crypto";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/worker/[workerId]/mega-session
 *
 * Dashboard-initiated re-link. The browser logs into Mega (password never
 * leaves the client) and stores the fresh session here, clearing the
 * "needs re-link" flag raised by the worker.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> }
) {
  const { workerId } = await params;

  const guestId = await getGuestId();
  if (!guestId) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const [worker] = await db
    .select({ id: workers.id })
    .from(workers)
    .where(and(eq(workers.id, workerId), eq(workers.guestId, guestId)))
    .limit(1);
  if (!worker) {
    return NextResponse.json({ success: false, message: "Worker not found" }, { status: 404 });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }

  const { email, sessionData } = body ?? {};
  if (!sessionData) {
    return NextResponse.json({ success: false, message: "Missing sessionData" }, { status: 400 });
  }

  await db
    .update(workers)
    .set({
      ...(typeof email === "string" && email.trim() ? { megaEmail: email.trim().toLowerCase() } : {}),
      megaSession:       encryptCredentials(String(sessionData)),
      megaNeedsRelink:   false,
      megaRelinkReason:  null,
      updatedAt:         new Date(),
    })
    .where(eq(workers.id, workerId));

  return NextResponse.json({ success: true, message: "Mega account re-linked" });
}