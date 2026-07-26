/**
 * GET /api/sync-worker
 *
 * Serves the SharedWorker script with:
 *  - Correct Content-Type (required for SharedWorker to load)
 *  - No-cache headers (ensures Chrome always fetches latest)
 *  - ETag based on file content hash (efficient revalidation)
 */

import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const workerPath = join(process.cwd(), "public", "sync-worker.js");
    const content = readFileSync(workerPath, "utf-8");

    // Content hash — changes whenever sync-worker.js changes
    const hash = createHash("md5").update(content).digest("hex").slice(0, 8);
    const etag = `"${hash}"`;

    // If client already has this version, return 304
    const ifNoneMatch = req.headers.get("if-none-match");
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    return new Response(content, {
      headers: {
        "Content-Type":  "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache",   // always revalidate, use ETag
        "ETag":          etag,
      },
    });
  } catch {
    return NextResponse.json({ error: "Worker script not found" }, { status: 404 });
  }
}
