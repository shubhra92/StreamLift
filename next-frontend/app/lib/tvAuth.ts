import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { tvDevices, workspaces } from "../db/schema";
import type { TvDevice, Workspace } from "../db/schema";
import {
  readSessionToken,
  SESSION_MAX_AGE,
} from "./sessionConstants";
import {
  validateSessionToken,
  type AuthContext,
} from "./sessionAuth";
import { tvHash } from "./tvCrypto";
import { consumeApprovedPairings } from "./tvPairing";

export type TvAuthResult =
  | { ok: true; device: TvDevice; workspace: Workspace }
  | { ok: false; response: NextResponse };

export type WebSessionResult =
  | { ok: true; context: AuthContext }
  | { ok: false; response: NextResponse };

function jsonError(message: string, status: number, code: string): NextResponse {
  return NextResponse.json(
    { success: false, error: code, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/**
 * Authenticate a TV request with its device bearer token.
 *
 * Anonymous workspace expiry is slid forward on every authenticated TV request.
 * Without this, a paired TV would silently stop working when the 30-day web
 * session expires. Permanent workspaces never expire.
 */
export async function requireTvDevice(req: NextRequest): Promise<TvAuthResult> {
  const token = bearerToken(req);
  if (!token) return { ok: false, response: jsonError("Unauthorized", 401, "unauthorized") };

  const [device] = await db
    .select()
    .from(tvDevices)
    .where(and(eq(tvDevices.tokenHash, tvHash(token)), isNull(tvDevices.revokedAt)))
    .limit(1);

  if (!device) {
    return { ok: false, response: jsonError("This TV is no longer connected.", 401, "device_revoked") };
  }

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, device.workspaceId), isNull(workspaces.deletedAt)))
    .limit(1);

  if (!workspace || !workspace.isActive) {
    return { ok: false, response: jsonError("This StreamLift session is no longer active.", 401, "workspace_inactive") };
  }

  const now = new Date();
  if (workspace.expiresAt && workspace.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, response: jsonError("This StreamLift session has expired. Pair the TV again.", 401, "workspace_expired") };
  }

  // Permanent accounts never expire. Anonymous workspaces keep sliding forward
  // so a paired TV can keep using the workspace without an open browser tab.
  const nextWorkspaceExpiry = workspace.ownerUserId
    ? null
    : new Date(now.getTime() + SESSION_MAX_AGE * 1000);

  await Promise.all([
    db
      .update(workspaces)
      .set({ expiresAt: nextWorkspaceExpiry, lastSeenAt: now })
      .where(eq(workspaces.id, workspace.id)),
    db
      .update(tvDevices)
      .set({ lastSeenAt: now })
      .where(eq(tvDevices.id, device.id)),
  ]);

  // The TV has used its bearer token; stop issuing pairing tokens.
  await consumeApprovedPairings(device.id).catch(() => {});

  return {
    ok: true,
    device: { ...device, lastSeenAt: now },
    workspace: {
      ...workspace,
      expiresAt: nextWorkspaceExpiry,
      lastSeenAt: now,
    },
  };
}

/** Authenticate a web request using the normal session cookie. */
export async function requireWebSession(req: NextRequest): Promise<WebSessionResult> {
  const context = await validateSessionToken(readSessionToken(req.cookies));
  if (!context) {
    return { ok: false, response: jsonError("Unauthorized", 401, "unauthorized") };
  }

  return { ok: true, context };
}

export function unauthorizedResponse(message = "Unauthorized", code = "unauthorized"): NextResponse {
  return jsonError(message, 401, code);
}
