import { NextRequest, NextResponse } from "next/server";
import { createWorker } from "@/app/actions/workers";
import { initWorkerStore } from "@/app/lib/initWorkerStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await initWorkerStore();

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }

  const result = await createWorker(body);

  if (!result.success) {
    return NextResponse.json(result, { status: 400 });
  }

  return NextResponse.json(result, { status: 201 });
}
