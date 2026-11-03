import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";
import { requireWorkspaceId } from "@/app/lib/sessionAuth";
import { clearStaleWorkerConnections, isWorkerOnline } from "@/app/lib/workerPresence";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> },
) {
  const auth = await requireWorkspaceId(req);
  if (!auth.ok) return auth.response;
  const workspaceId = auth.workspaceId;

  const { workerId } = await params;

  const [worker] = await db
    .select()
    .from(workers)
    .where(eq(workers.id, workerId))
    .limit(1);

  if (!worker || worker.workspaceId !== workspaceId) {
    return NextResponse.json({ success: false, message: "Worker not found" }, { status: 404 });
  }

  await clearStaleWorkerConnections(workspaceId);

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
    tunnelUrl:     freshWorker.tunnelUrl    ?? null,
    version:       freshWorker.version,
  });
}
