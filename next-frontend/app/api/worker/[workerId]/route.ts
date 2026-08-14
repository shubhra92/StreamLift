import { NextRequest, NextResponse } from "next/server";
import { getWorkerById, deleteWorker } from "@/app/actions/workers";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> }
) {
  const { workerId } = await params;
  const data = await getWorkerById(workerId);

  if (!data) {
    return NextResponse.json({ success: false, message: "Worker not found" }, { status: 404 });
  }

  // Never expose megaPassword or auth/session tokens
  const { megaPassword: _pw, authToken: _tok, pinggyToken: _pt, sessionToken: _st, ...safe } = data as any;
  return NextResponse.json({ success: true, data: safe });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> }
) {
  const { workerId } = await params;
  const result = await deleteWorker(workerId);

  if (!result.success) {
    return NextResponse.json(result, { status: 400 });
  }

  return NextResponse.json(result);
}
