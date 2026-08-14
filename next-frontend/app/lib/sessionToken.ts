/**
 * Session token utilities for worker direct-access auth.
 * Tokens are crypto-random, stored in the workers table, and expire after 4 hours.
 */

import crypto from "crypto";
import { db } from "../db";
import { workers } from "../db/schema";
import { eq } from "drizzle-orm";

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
  workerPinggyUrl: string,
  workerAuthToken: string,
): Promise<string> {
  const newToken  = generateSessionToken();
  const newExpiry = sessionTokenExpiry();

  // Pinggy TCP tunnel returns tcp://host:port — convert to http:// for API calls
  const workerHttpUrl = workerPinggyUrl.startsWith("tcp://")
    ? workerPinggyUrl.replace("tcp://", "http://")
    : workerPinggyUrl;

  // Tell the worker about the new token first — if this fails, don't save to DB
  const res = await fetch(`${workerHttpUrl}/internal/rotate-token`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": workerAuthToken,
    },
    body: JSON.stringify({ newSessionToken: newToken }),
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
