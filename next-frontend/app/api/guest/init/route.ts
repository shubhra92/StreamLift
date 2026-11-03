import { NextRequest } from "next/server";
import { GET as sessionInit } from "@/app/api/session/init/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Deprecated alias for /api/session/init — remove after one release. */
export async function GET(req: NextRequest) {
  return sessionInit(req);
}
