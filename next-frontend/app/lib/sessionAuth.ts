/**
 * Workspace + per-device auth sessions.
 *
 * @remarks
 * This module uses Node.js APIs (crypto, postgres) and must not be imported by
 * the Edge middleware. `proxy.ts` only imports `sessionConstants.ts`.
 *
 * A guest is a workspace with `ownerUserId === null` accessed by a session with
 * `userId === null`. A permanent account is a workspace with an owner accessed
 * by an authenticated session.
 */

import crypto from "crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { authSessions, users, workspaces } from "../db/schema";
import type { AuthSession, User, Workspace } from "../db/schema";
import {
  readSessionToken,
  SESSION_MAX_AGE,
} from "./sessionConstants";

export { SESSION_COOKIE_NAME, SESSION_MAX_AGE } from "./sessionConstants";

/** The subset of a user that may be attached to a request context. */
export type AuthenticatedUser = Pick<User, "id" | "email" | "createdAt">;

export interface AuthContext {
  session: AuthSession;
  workspace: Workspace;
  user: AuthenticatedUser | null;
}

export type RequireAuthResult =
  | { ok: true; context: AuthContext }
  | { ok: false; response: NextResponse };

export type RequireWorkspaceResult =
  | { ok: true; workspaceId: string; context: AuthContext }
  | { ok: false; response: NextResponse };

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex"); // 256-bit token, 64 hex chars
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sessionExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_MAX_AGE * 1000);
}

function jsonError(message: string, status: number, code: string): NextResponse {
  return NextResponse.json(
    { success: false, error: code, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Validate a raw cookie token and slide both the session and (for anonymous
 * workspaces) the workspace expiry forward.
 *
 * Returns null for revoked, expired, inactive, deleted, or mismatched sessions.
 */
export async function validateSessionToken(
  token: string | null | undefined,
): Promise<AuthContext | null> {
  if (!token) return null;

  const now = new Date();
  const [row] = await db
    .select({
      session: authSessions,
      workspace: workspaces,
      user: users,
    })
    .from(authSessions)
    .innerJoin(workspaces, eq(authSessions.workspaceId, workspaces.id))
    .leftJoin(users, eq(authSessions.userId, users.id))
    .where(
      and(
        eq(authSessions.tokenHash, hashSessionToken(token)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
        eq(workspaces.isActive, true),
        isNull(workspaces.deletedAt),
        or(isNull(workspaces.expiresAt), gt(workspaces.expiresAt, now)),
      ),
    )
    .limit(1);

  if (!row) return null;

  const { session, workspace, user } = row;

  // Keep the session and workspace ownership in lockstep. A session can never
  // grant access to a workspace it does not belong to.
  if (workspace.ownerUserId) {
    if (!user || session.userId !== workspace.ownerUserId) return null;
  } else if (session.userId !== null) {
    return null;
  }

  const nextExpiry = sessionExpiry(now);
  const nextWorkspaceExpiry = workspace.ownerUserId ? null : nextExpiry;

  // Slide both windows. Permanent account workspaces stay permanent.
  await Promise.all([
    db
      .update(authSessions)
      .set({ expiresAt: nextExpiry, lastSeenAt: now })
      .where(eq(authSessions.id, session.id)),
    db
      .update(workspaces)
      .set({ expiresAt: nextWorkspaceExpiry, lastSeenAt: now })
      .where(eq(workspaces.id, workspace.id)),
  ]);

  return {
    session: { ...session, expiresAt: nextExpiry, lastSeenAt: now },
    workspace: {
      ...workspace,
      expiresAt: nextWorkspaceExpiry,
      lastSeenAt: now,
    },
    user: user
      ? { id: user.id, email: user.email, createdAt: user.createdAt }
      : null,
  };
}

/** Read and validate the current browser session inside a Server Action. */
export async function getAuthContext(): Promise<AuthContext | null> {
  try {
    const cookieStore = await cookies();
    return validateSessionToken(readSessionToken(cookieStore));
  } catch {
    return null;
  }
}

/**
 * Convenience for server actions and route handlers that only need the tenant
 * boundary. Returns null when called outside a request context.
 */
export async function getWorkspaceId(): Promise<string | null> {
  return (await getAuthContext())?.workspace.id ?? null;
}

/** Route-handler helper: validates the session or returns a 401 response. */
export async function requireAuthContext(
  req: NextRequest,
): Promise<RequireAuthResult> {
  const context = await validateSessionToken(readSessionToken(req.cookies));
  if (!context) {
    return {
      ok: false,
      response: jsonError("Unauthorized", 401, "unauthorized"),
    };
  }
  return { ok: true, context };
}

/** Convenience wrapper for routes that only need the tenant id. */
export async function requireWorkspaceId(
  req: NextRequest,
): Promise<RequireWorkspaceResult> {
  const auth = await requireAuthContext(req);
  if (!auth.ok) return auth;
  return {
    ok: true,
    workspaceId: auth.context.workspace.id,
    context: auth.context,
  };
}

/** Create a new anonymous workspace and its first device session. */
export async function createAnonymousSession(
  ipAddress?: string | null,
  userAgent?: string | null,
): Promise<{ context: AuthContext; token: string }> {
  const token = generateSessionToken();
  const now = new Date();
  const expiresAt = sessionExpiry(now);

  const result = await db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        ownerUserId: null,
        name: "Personal workspace",
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
        isActive: true,
        lastSeenAt: now,
        expiresAt,
      })
      .returning();

    const [session] = await tx
      .insert(authSessions)
      .values({
        tokenHash: hashSessionToken(token),
        workspaceId: workspace.id,
        userId: null,
        expiresAt,
        lastSeenAt: now,
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
      })
      .returning();

    return { workspace, session };
  });

  return {
    context: { ...result, user: null },
    token,
  };
}

/** Create an authenticated device session for an existing permanent workspace. */
export async function createUserSession(
  workspace: Workspace,
  user: AuthenticatedUser,
  ipAddress?: string | null,
  userAgent?: string | null,
): Promise<{ context: AuthContext; token: string }> {
  const token = generateSessionToken();
  const now = new Date();
  const expiresAt = sessionExpiry(now);

  // The workspace and user already exist and were committed before login, so
  // this only needs to insert the device session. Login has already made the
  // workspace permanent.
  const [session] = await db
    .insert(authSessions)
    .values({
      tokenHash: hashSessionToken(token),
      workspaceId: workspace.id,
      userId: user.id,
      expiresAt,
      lastSeenAt: now,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    })
    .returning();

  return {
    context: { workspace, session, user },
    token,
  };
}

/**
 * Resolve an existing token or create a fresh anonymous workspace. Used by
 * `/api/session/init`, registration, and direct visits to `/register`.
 */
export async function resolveOrCreateSession(
  token: string | null | undefined,
  ipAddress?: string | null,
  userAgent?: string | null,
): Promise<{ context: AuthContext; token: string; isNew: boolean }> {
  if (token) {
    const existing = await validateSessionToken(token);
    if (existing) return { context: existing, token, isNew: false };
  }

  const created = await createAnonymousSession(ipAddress, userAgent);
  return { ...created, isNew: true };
}

/** Revoke one device session. Other devices stay signed in. */
export async function revokeSession(sessionId: string): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(eq(authSessions.id, sessionId));
}

/** Revoke every session for a user, optionally keeping the current one. */
export async function revokeUserSessions(
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  const rows = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(
      and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)),
    );

  const ids = rows
    .map((row) => row.id)
    .filter((id) => id !== exceptSessionId);

  if (ids.length === 0) return;

  await Promise.all(ids.map((id) => revokeSession(id)));
}

export function unauthorizedResponse(
  message = "Unauthorized",
  code = "unauthorized",
): NextResponse {
  return jsonError(message, 401, code);
}
