import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";
import { generateSessionToken, sessionTokenExpiry } from "@/app/lib/sessionToken";
import { resolveIpCountryCode } from "@/app/lib/ipGeolocation";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }

  const { workerId, authToken, ipAddress, version, pinggyUrl } = body ?? {};

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing workerId or authToken" }, { status: 401 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  // Generate a fresh session token for direct client access
  const sessionToken = generateSessionToken();
  const tokenExpiry  = sessionTokenExpiry();
  const normalizedIpAddress = typeof ipAddress === "string" && ipAddress.trim() ? ipAddress.trim() : null;
  const [existingWorker] = await db
    .select({ ipAddress: workers.ipAddress, countryCode: workers.countryCode })
    .from(workers)
    .where(eq(workers.id, workerId))
    .limit(1);
  // Keep a known country while the same tunnel IP re-registers. A geo-IP
  // lookup is only needed when Colab/Pinggy supplies a different public IP.
  const countryCode = existingWorker?.ipAddress === normalizedIpAddress
    ? existingWorker.countryCode
    : await resolveIpCountryCode(normalizedIpAddress);

  // Persist pinggy URL + session token + heartbeat to DB
  await db
    .update(workers)
    .set({
      pinggyUrl:          pinggyUrl ?? null,
      lastHeartbeat:      new Date(),
      ipAddress:          normalizedIpAddress,
      countryCode,
      sessionToken,
      sessionTokenExpiry: tokenExpiry,
      updatedAt:          new Date(),
    })
    .where(eq(workers.id, workerId));

  return NextResponse.json({
    success:      true,
    message:      "Worker registered successfully",
    sessionToken,                          // returned once — worker passes to FastAPI server
    config: {
      heartbeatEndpoint: "/api/worker/heartbeat",
      statusEndpoint:    "/api/worker/status-update",
    },
  });
}
