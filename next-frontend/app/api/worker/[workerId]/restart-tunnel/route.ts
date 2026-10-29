import { NextRequest, NextResponse } from "next/server";
import { requestTunnelRestart } from "@/app/actions/workers";

export const dynamic = "force-dynamic";

/**
 * POST /api/worker/[workerId]/restart-tunnel
 *
 * Queues a tunnel-only restart for a worker. The signal travels through the
 * worker's heartbeat, so it works even when the current tunnel is unreachable.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> },
) {
  const { workerId } = await params;
  const result = await requestTunnelRestart(workerId);
  if (!result.success) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
