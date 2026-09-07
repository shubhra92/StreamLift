import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";
import { decryptCredentials } from "@/app/lib/crypto";

export const dynamic = "force-dynamic";

/**
 * GET /api/worker/config
 *
 * Worker bootstrap config for session-only workers. Returns everything a
 * worker needs to start when Mega credentials are NOT embedded in its Colab
 * script: download/compute settings, the (decrypted) Pinggy token, and the
 * (decrypted) Mega session minted by the browser.
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

  const [worker] = await db
    .select()
    .from(workers)
    .where(eq(workers.id, workerId))
    .limit(1);

  if (!worker) {
    return NextResponse.json({ success: false, message: "Worker not found" }, { status: 404 });
  }

  let pinggyToken: string | null = null;
  if (worker.pinggyToken) {
    try { pinggyToken = decryptCredentials(worker.pinggyToken); } catch { pinggyToken = null; }
  }

  let megaSession: any = null;
  if (worker.megaSession) {
    try { megaSession = JSON.parse(decryptCredentials(worker.megaSession)); } catch { megaSession = null; }
  }

  return NextResponse.json({
    success: true,
    data: {
      workerId:        worker.id,
      downloadLocation: worker.downloadLocation,
      computeType:      worker.computeType,
      pinggyToken,
      megaSession,
    },
  });
}