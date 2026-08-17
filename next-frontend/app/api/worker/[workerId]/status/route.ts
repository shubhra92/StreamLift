import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";
import { validateGuestToken, GUEST_COOKIE_NAME } from "@/app/lib/guestAuth";
import { clearStaleWorkerConnections, isWorkerOnline } from "@/app/lib/workerPresence";

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

  await clearStaleWorkerConnections(guest.id);

  const [freshWorker] = await db
    .select()
    .from(workers)
    .where(eq(workers.id, workerId))
    .limit(1);
  if (!freshWorker) return NextResponse.json({ success: false, message: "Worker not found" }, { status: 404 });

  const online = isWorkerOnline(freshWorker.lastHeartbeat);

  return NextResponse.json({
    online,
    ipAddress:     freshWorker.ipAddress    ?? null,
    lastHeartbeat: freshWorker.lastHeartbeat?.toISOString() ?? null,
    pinggyUrl:     freshWorker.pinggyUrl    ?? null,
    version:       freshWorker.version,
  });
}
