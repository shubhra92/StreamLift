import { NextRequest, NextResponse } from "next/server";
import { getWorkers } from "@/app/actions/workers";
import { initWorkerStore } from "@/app/lib/initWorkerStore";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  await initWorkerStore();
  const data = await getWorkers();
  return NextResponse.json({ success: true, data });
}
