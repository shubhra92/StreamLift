import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }

  const { workerId, authToken, pinggyUrl } = body ?? {};

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing credentials" }, { status: 401 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  // Update last_heartbeat + pinggy_url in DB — this is the source of truth for online status
  await db
    .update(workers)
    .set({
      lastHeartbeat: new Date(),
      ...(pinggyUrl ? { pinggyUrl } : {}),
      updatedAt: new Date(),
    })
    .where(eq(workers.id, workerId));

  // No newTasks — task dispatch is now triggered directly by the client via worker API
  return NextResponse.json({ success: true });
}
