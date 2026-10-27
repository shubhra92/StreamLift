/**
 * Session token utilities for worker direct-access auth.
 * Tokens are crypto-random, stored in the workers table, and expire after 4 hours.
 */

import crypto from "crypto";
import { db } from "../db";
import { workers } from "../db/schema";
import { eq } from "drizzle-orm";
import { getTunnelBypassHeaders } from "./tunnelHeaders";

const SESSION_TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function sessionTokenExpiry(): Date {
  return new Date(Date.now() + SESSION_TOKEN_TTL_MS);
}

export function isSessionTokenExpired(expiry: Date | null): boolean {
  if (!expiry) return true;
  return new Date(expiry).getTime() < Date.now();
}

/**
 * Rotate the session token for a worker:
 * 1. Generate a new token
 * 2. Call the worker's /internal/rotate-token endpoint
 * 3. Save the new token to DB
 * Returns the new token, or throws on failure.
 */
export async function rotateSessionToken(
  workerId: string,
  workerTunnelUrl: string,
  workerAuthToken: string,
): Promise<string> {
  const newToken  = generateSessionToken();
  const newExpiry = sessionTokenExpiry();

  if (!workerTunnelUrl.startsWith("https://")) {
    throw new Error("Worker tunnel must use HTTPS");
  }

  // Tell the worker about the new token first — if this fails, don't save to DB
  const res = await fetch(`${workerTunnelUrl}/internal/rotate-token`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": workerAuthToken,
      // Tunnel interstitials (e.g. zrok free tier) must not swallow this
      // server-side call; the map is empty for tunnel providers that don't
      // need a bypass header.
      ...getTunnelBypassHeaders(workerTunnelUrl),
    },
    body: JSON.stringify({ newSessionToken: newToken }),
    // A dead tunnel must not hang catalog/connection requests forever.
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) {
    throw new Error(`Worker rejected token rotation: ${res.status}`);
  }

  // Worker accepted — persist to DB
  await db
    .update(workers)
    .set({
      sessionToken:       newToken,
      sessionTokenExpiry: newExpiry,
      updatedAt:          new Date(),
    })
    .where(eq(workers.id, workerId));

  return newToken;
}
