import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";
import { decryptCredentials } from "@/app/lib/crypto";
import { parseTunnelConfig } from "@/app/lib/tunnelConfig";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }

  const { workerId, authToken, tunnelUrl } = body ?? {};

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing credentials" }, { status: 401 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  // Update last_heartbeat + tunnel_url in DB — this is the source of truth for online status.
  // Return tunnel_config so the worker can detect a queued "Restart tunnel" request.
  const [worker] = await db
    .update(workers)
    .set({
      lastHeartbeat: new Date(),
      ...(tunnelUrl ? { tunnelUrl } : {}),
      updatedAt: new Date(),
    })
    .where(eq(workers.id, workerId))
    .returning({ tunnelConfig: workers.tunnelConfig });

  let tunnelRestartNonce: string | null = null;
  if (worker?.tunnelConfig) {
    try {
      tunnelRestartNonce =
        parseTunnelConfig(decryptCredentials(worker.tunnelConfig)).restartNonce ?? null;
    } catch {
      // A malformed/legacy config simply means there is nothing to apply.
    }
  }

  // No newTasks — task dispatch is now triggered directly by the client via worker API
  return NextResponse.json({ success: true, tunnelRestartNonce });
}
