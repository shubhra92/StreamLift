import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { initWorkerStore } from "@/app/lib/initWorkerStore";
import { db } from "@/app/db";
import { megaSessions } from "@/app/db/schema";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * GET /api/worker/mega-session
 * Worker fetches its saved Mega session SID.
 * Query params: workerId, authToken
 */
export async function GET(req: NextRequest) {
  await initWorkerStore();

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
 * Worker saves its Mega session SID after a fresh login.
 * Body: { workerId, authToken, email, sessionData }
 */
export async function POST(req: NextRequest) {
  await initWorkerStore();

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

  if (!email || !sessionData) {
    return NextResponse.json({ success: false, message: "Missing email or sessionData" }, { status: 400 });
  }

  // Upsert: update existing or insert new
  const [existing] = await db
    .select()
    .from(megaSessions)
    .where(eq(megaSessions.workerId, workerId))
    .limit(1);

  if (existing) {
    await db
      .update(megaSessions)
      .set({ sessionData, email, isActive: true, updatedAt: new Date() })
      .where(eq(megaSessions.id, existing.id));
  } else {
    await db.insert(megaSessions).values({
      email,
      sessionData,
      workerId,
      isActive: true,
    });
  }

  return NextResponse.json({ success: true, message: "Session saved" });
}
