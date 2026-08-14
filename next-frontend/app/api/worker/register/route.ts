import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";
import { generateSessionToken, sessionTokenExpiry } from "@/app/lib/sessionToken";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }

  const { workerId, authToken, ipAddress, version, pinggyUrl } = body ?? {};

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing workerId or authToken" }, { status: 401 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  // Generate a fresh session token for direct client access
  const sessionToken = generateSessionToken();
  const tokenExpiry  = sessionTokenExpiry();

  // Persist pinggy URL + session token + heartbeat to DB
  await db
    .update(workers)
    .set({
      pinggyUrl:          pinggyUrl ?? null,
      lastHeartbeat:      new Date(),
      ipAddress:          ipAddress ?? null,
      sessionToken,
      sessionTokenExpiry: tokenExpiry,
      updatedAt:          new Date(),
    })
    .where(eq(workers.id, workerId));

  return NextResponse.json({
    success:      true,
    message:      "Worker registered successfully",
    sessionToken,                          // returned once — worker passes to FastAPI server
    config: {
      heartbeatEndpoint: "/api/worker/heartbeat",
      statusEndpoint:    "/api/worker/status-update",
      logsEndpoint:      "/api/worker/logs",
    },
  });
}
