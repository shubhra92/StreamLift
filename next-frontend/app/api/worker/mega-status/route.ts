import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * POST /api/worker/mega-status
 *
 * Called by the Python worker to signal that its Mega session is broken and
 * the user needs to re-link the account. Sets a flag on the worker row that
 * the dashboard surfaces as a "Mega session expired — Re-link" prompt.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }

  const { workerId, authToken, needsRelink, reason } = body ?? {};

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing credentials" }, { status: 401 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  await db
    .update(workers)
    .set({
      megaNeedsRelink: Boolean(needsRelink),
      megaRelinkReason: typeof reason === "string" && reason ? reason : null,
      updatedAt: new Date(),
    })
    .where(eq(workers.id, workerId));

  return NextResponse.json({ success: true });
}