import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { requireTvDevice } from "@/app/lib/tvAuth";
import { isWorkerOnline } from "@/app/lib/workerPresence";
import { isSessionTokenExpired, rotateSessionToken } from "@/app/lib/sessionToken";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/tv/workers/[workerId]/connection
 *
 * Gives a paired TV the worker tunnel URL + short-lived session token. The TV
 * uses these directly against the worker for media tickets and thumbnails;
 * the tunnel URL never needs to be proxied through Next.js.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> },
) {
  const auth = await requireTvDevice(req);
  if (!auth.ok) return auth.response;

  const { workerId } = await params;
  const [worker] = await db.select().from(workers).where(eq(workers.id, workerId)).limit(1);

  if (!worker || worker.guestId !== auth.guest.id) {
    return NextResponse.json(
      { success: false, error: "not_found", message: "Worker not found" },
      { status: 404 },
    );
  }

  if (worker.downloadLocation !== "local") {
    return NextResponse.json(
      { success: false, error: "not_local", message: "This worker does not store files locally" },
      { status: 409 },
    );
  }

  if (!worker.pinggyUrl || !worker.pinggyUrl.startsWith("https://")) {
    return NextResponse.json(
      { success: false, error: "worker_offline", message: "Worker tunnel is offline" },
      { status: 503 },
    );
  }

  if (!isWorkerOnline(worker.lastHeartbeat)) {
    return NextResponse.json(
      { success: false, error: "worker_offline", message: "Worker is offline" },
      { status: 503 },
    );
  }

  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";
  let sessionToken = worker.sessionToken;
  if (forceRefresh || !sessionToken || isSessionTokenExpired(worker.sessionTokenExpiry)) {
    try {
      sessionToken = await rotateSessionToken(worker.id, worker.pinggyUrl, worker.authToken);
    } catch (error) {
      console.error(`TV worker connection refresh failed for ${worker.id}:`, error);
      return NextResponse.json(
        { success: false, error: "worker_unreachable", message: "Could not reach the worker" },
        { status: 502 },
      );
    }
  }

  return NextResponse.json(
    {
      success: true,
      workerId: worker.id,
      workerName: worker.name,
      pinggyUrl: worker.pinggyUrl.replace(/\/+$/, ""),
      sessionToken,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
