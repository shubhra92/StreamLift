import { NextRequest } from "next/server";
import { GET as sessionMe } from "@/app/api/session/me/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Deprecated alias for /api/session/me — remove after one release. */
export async function GET(req: NextRequest) {
  return sessionMe(req);
}
