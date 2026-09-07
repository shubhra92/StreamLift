import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { db } from "@/app/db";
import { megaSessions, workers } from "@/app/db/schema";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * GET /api/worker/mega-session
 */
export async function GET(req: NextRequest) {
  const workerId  = req.nextUrl.searchParams.get("workerId");
  const authToken = req.nextUrl.searchParams.get("authToken");

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing credentials" }, { status: 401 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  const [session] = await db
    .select()
    .from(megaSessions)
    .where(
      and(
        eq(megaSessions.workerId, workerId),
        eq(megaSessions.isActive, true),
      )
    )
    .limit(1);

  if (!session || !session.sessionData) {
    return NextResponse.json({ success: false, message: "No session found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, sessionData: session.sessionData });
}

/**
 * POST /api/worker/mega-session
 */
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }

  const { workerId, authToken, email, sessionData } = body ?? {};

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing credentials" }, { status: 401 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  // sessionData === null means "clear" — purge the worker's stored session.
  if (sessionData == null) {
    await db.update(workers).set({ megaSession: null, updatedAt: new Date() }).where(eq(workers.id, workerId));
    await db
      .update(megaSessions)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(megaSessions.workerId, workerId));
    return NextResponse.json({ success: true, message: "Session cleared" });
  }

  if (!sessionData) {
    return NextResponse.json({ success: false, message: "Missing sessionData" }, { status: 400 });
  }

  // Upsert into mega_sessions (legacy worker-saved sessions). Email is now
  // optional to support session-only workers.
  const [existing] = await db
    .select()
    .from(megaSessions)
    .where(eq(megaSessions.workerId, workerId))
    .limit(1);

  if (existing) {
    await db
      .update(megaSessions)
      .set({
        ...(typeof email === "string" ? { email } : { email: existing.email }),
        sessionData, isActive: true, updatedAt: new Date(),
      })
      .where(eq(megaSessions.id, existing.id));
  } else {
    await db.insert(megaSessions).values({
      email: typeof email === "string" && email ? email : "unknown",
      sessionData,
      workerId,
      isActive: true,
    });
  }

  return NextResponse.json({ success: true, message: "Session saved" });
}
