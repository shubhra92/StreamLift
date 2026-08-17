import { and, eq, isNotNull, lt, or } from "drizzle-orm";
import { db } from "@/app/db";
import { workers } from "@/app/db/schema";

export const ONLINE_THRESHOLD_MS = 20_000;

export function isWorkerOnline(lastHeartbeat: Date | null | undefined, now = Date.now()): boolean {
  return Boolean(lastHeartbeat && now - lastHeartbeat.getTime() < ONLINE_THRESHOLD_MS);
}

/**
 * A Pinggy URL and its IP are both session-specific. Once a worker misses its
 * heartbeat window, remove those stale connection details together. This is
 * intentionally safe to call from every status read; only stale rows that
 * still contain connection data are updated.
 */
export async function clearStaleWorkerConnections(guestId?: string): Promise<void> {
  const cutoff = new Date(Date.now() - ONLINE_THRESHOLD_MS);
  const conditions = [
    lt(workers.lastHeartbeat, cutoff),
    or(
      isNotNull(workers.pinggyUrl),
      isNotNull(workers.ipAddress),
      isNotNull(workers.countryCode),
      isNotNull(workers.sessionToken),
    ),
  ];
  if (guestId) conditions.unshift(eq(workers.guestId, guestId));

  await db
    .update(workers)
    .set({
      pinggyUrl: null,
      ipAddress: null,
      countryCode: null,
      sessionToken: null,
      sessionTokenExpiry: null,
      updatedAt: new Date(),
    })
    .where(and(...conditions));
}
