import { NextRequest, NextResponse } from "next/server";
import { getWorkerById, deleteWorker, updateWorker } from "@/app/actions/workers";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> },
) {
  const { workerId } = await params;
  const data = await getWorkerById(workerId);
  if (!data) {
    return NextResponse.json({ success: false, message: "Worker not found" }, { status: 404 });
  }
  // Never expose megaSession or auth/session tokens or raw tunnel credentials
  const {
    megaSession: _ms,
    authToken:   _tok,
    tunnelConfig: _tc,
    sessionToken: _st,
    ...safe
  } = data as any;
  return NextResponse.json({ success: true, data: safe });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> },
) {
  const { workerId } = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }
  const result = await updateWorker(workerId, body);
  if (!result.success) {
    return NextResponse.json(result, { status: 400 });
  }
  // Strip sensitive fields from response
  const {
    megaSession: _ms,
    authToken:   _tok,
    tunnelConfig: _tc,
    sessionToken: _st,
    ...safe
  } = (result.data ?? {}) as any;
  return NextResponse.json({ success: true, data: safe });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ workerId: string }> },
) {
  const { workerId } = await params;
  const result = await deleteWorker(workerId);
  if (!result.success) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
