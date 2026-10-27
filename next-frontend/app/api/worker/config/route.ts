import { NextRequest, NextResponse } from "next/server";
import { validateWorkerAuth } from "@/app/lib/workerAuth";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";
import { eq } from "drizzle-orm";
import { decryptCredentials } from "@/app/lib/crypto";
import {
  parseTunnelConfig,
  getPinggyToken,
  getZrokToken,
  getTunnlGgSshKeyPath,
  type TunnelProvider,
} from "@/app/lib/tunnelConfig";

export const dynamic = "force-dynamic";

/**
 * GET /api/worker/config
 *
 * Worker bootstrap config. Returns everything a worker needs at startup:
 * - download/compute settings
 * - active tunnel provider + its decrypted credentials
 * - decrypted Mega session (session-only mode)
 *
 * The worker reads this once at boot via __main__.py → api.fetch_worker_config().
 */
export async function GET(req: NextRequest) {
  const workerId  = req.nextUrl.searchParams.get("workerId");
  const authToken = req.nextUrl.searchParams.get("authToken");

  if (!workerId || !authToken) {
    return NextResponse.json({ success: false, message: "Missing credentials" }, { status: 401 });
  }

  const auth = await validateWorkerAuth(workerId, authToken);
  if (!auth.valid) {
    return NextResponse.json({ success: false, message: "Invalid credentials" }, { status: 401 });
  }

  const [worker] = await db
    .select()
    .from(workers)
    .where(eq(workers.id, workerId))
    .limit(1);

  if (!worker) {
    return NextResponse.json({ success: false, message: "Worker not found" }, { status: 404 });
  }

  // ── Resolve tunnel credentials ────────────────────────────────────────────
  const provider: TunnelProvider =
    (worker.activeTunnelProvider as TunnelProvider | null) ?? "pinggy";

  let pinggyToken: string | null = null;
  let zrokToken: string | null = null;
  let tunnlggSshKeyPath: string | null = null;

  if (worker.tunnelConfig) {
    try {
      const raw = decryptCredentials(worker.tunnelConfig);
      const cfg = parseTunnelConfig(raw);
      pinggyToken       = getPinggyToken(cfg) || null;
      zrokToken         = getZrokToken(cfg) || null;
      tunnlggSshKeyPath = getTunnlGgSshKeyPath(cfg) || null;
    } catch {
      // decryption failed — credentials will be null
    }
  }

  // ── Mega session ──────────────────────────────────────────────────────────
  let megaSession: any = null;
  if (worker.megaSession) {
    try {
      megaSession = JSON.parse(decryptCredentials(worker.megaSession));
    } catch {
      megaSession = null;
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      workerId:             worker.id,
      downloadLocation:     worker.downloadLocation,
      computeType:          worker.computeType,
      tunnelProvider:       provider,
      pinggyToken,
      zrokToken,
      tunnlggSshKeyPath,
      megaSession,
    },
  });
}
