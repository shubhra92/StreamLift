import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";
import { generateWorkerScript } from "@/app/lib/generateWorkerScript";
import { initWorkerStore } from "@/app/lib/initWorkerStore";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> }
) {
  await initWorkerStore();
  const { workerId } = await params;

  const [worker] = await db
    .select()
    .from(workers)
    .where(eq(workers.id, workerId))
    .limit(1);

  if (!worker) {
    return NextResponse.json({ success: false, message: "Worker not found" }, { status: 404 });
  }

  // Derive the public API base URL from the request
  const host = req.headers.get("host") ?? "localhost:3000";
  const protocol = req.headers.get("x-forwarded-proto") ?? "http";
  const apiBaseUrl = `${protocol}://${host}`;

  const script = generateWorkerScript(worker, apiBaseUrl);

  return NextResponse.json({ success: true, script });
}
