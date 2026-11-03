/**
 * Permanent account credentials.
 *
 * A user owns exactly one workspace through `workspaces.owner_user_id`.
 * Registering claims the anonymous workspace that already owns workers,
 * downloads, TV devices, and storage folders — nothing moves.
 *
 * Passwords are hashed with Node's scrypt (no extra dependency). The stored
 * format is:
 *
 *   scrypt$N$r$p$<base64 salt>$<base64 key>
 *
 * Parameter values are embedded so they can be raised later without breaking
 * existing hashes.
 */

import crypto from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { authSessions, users, workspaces } from "../db/schema";
import type { Workspace } from "../db/schema";
import {
  generateSessionToken,
  hashSessionToken,
  SESSION_MAX_AGE,
} from "./sessionAuth";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;
const SCRYPT_SALT_LEN = 16;
const SCRYPT_MAX_MEM = 64 * 1024 * 1024;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

export interface AccountSummary {
  id: string;
  email: string;
  createdAt: Date | null;
}

export type RegisterAccountResult =
  | {
      ok: true;
      workspace: Workspace;
      account: AccountSummary;
      token: string;
    }
  | {
      ok: false;
      code: "already_registered" | "email_taken" | "workspace_missing";
      message: string;
    };

export type AuthenticateResult =
  | {
      ok: true;
      workspace: Workspace;
      user: { id: string; email: string; createdAt: Date | null };
    }
  | {
      ok: false;
      code: "invalid_credentials" | "inactive";
      message: string;
    };

// ── Validation ──────────────────────────────────────────────────────────────

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  if (!email || email.length > 254) return false;
  // Deliberately permissive — the real check is delivery, and this app does
  // not send mail. Reject obvious malformed input only.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidPassword(password: string): boolean {
  return (
    typeof password === "string" &&
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH
  );
}

// ── Password hashing ────────────────────────────────────────────────────────

function deriveKey(
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SCRYPT_SALT_LEN);
  const key = await deriveKey(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEM,
  });

  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    const [scheme, nRaw, rRaw, pRaw, saltRaw, keyRaw] = stored.split("$");
    if (scheme !== "scrypt" || !nRaw || !rRaw || !pRaw || !saltRaw || !keyRaw) {
      return false;
    }

    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
      return false;
    }
    // Guard against a malformed row turning verification into a DoS.
    if (N < 1_024 || N > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) {
      return false;
    }

    const salt = Buffer.from(saltRaw, "base64");
    const expected = Buffer.from(keyRaw, "base64");
    if (salt.length === 0 || expected.length === 0) return false;

    const actual = await deriveKey(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAX_MEM,
    });

    return (
      actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Used when an email does not exist so a failed login costs the same time as a
 * successful one. Prevents account enumeration through response timing.
 */
function getDummyHash(): Promise<string> {
  if (!dummyHash) {
    dummyHash = hashPassword(crypto.randomBytes(16).toString("hex"));
  }
  return dummyHash;
}

// ── Account operations ──────────────────────────────────────────────────────

export async function getAccountForWorkspace(
  workspaceId: string,
): Promise<AccountSummary | null> {
  const [account] = await db
    .select({
      id: users.id,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .innerJoin(workspaces, eq(workspaces.ownerUserId, users.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  return account ?? null;
}

function uniqueViolationConstraint(error: unknown): string | null {
  const direct = error as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    cause?: {
      code?: string;
      constraint?: string;
      constraint_name?: string;
    };
  };
  if (direct?.code === "23505") {
    return direct.constraint ?? direct.constraint_name ?? null;
  }
  if (direct?.cause?.code === "23505") {
    return direct.cause.constraint ?? direct.cause.constraint_name ?? null;
  }
  return null;
}

class WorkspaceClaimError extends Error {}

export async function registerWorkspaceAccount(
  workspaceId: string,
  rawEmail: string,
  password: string,
  ipAddress?: string | null,
  userAgent?: string | null,
): Promise<RegisterAccountResult> {
  const email = normalizeEmail(rawEmail);

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .limit(1);

  if (!workspace) {
    return {
      ok: false,
      code: "workspace_missing",
      message: "This session has expired. Refresh the page and try again.",
    };
  }

  if (workspace.ownerUserId) {
    return {
      ok: false,
      code: "already_registered",
      message: "This session already has an account. Sign in instead.",
    };
  }

  const [emailOwner] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (emailOwner) {
    return {
      ok: false,
      code: "email_taken",
      message: "This email is already registered. Try signing in.",
    };
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();
  const sessionExpiresAt = new Date(now.getTime() + SESSION_MAX_AGE * 1000);
  const token = generateSessionToken();

  try {
    // Claim the workspace and create the first authenticated session in one
    // transaction. A separate session transaction could observe a stale
    // snapshot on pooled Postgres connections immediately after the claim.
    return await db.transaction(async (tx) => {
      const [account] = await tx
        .insert(users)
        .values({
          email,
          passwordHash,
          lastLoginAt: now,
          updatedAt: now,
        })
        .returning({
          id: users.id,
          email: users.email,
          createdAt: users.createdAt,
        });

      const [claimed] = await tx
        .update(workspaces)
        .set({
          ownerUserId: account.id,
          expiresAt: null,
          deletedAt: null,
          isActive: true,
          lastSeenAt: now,
        })
        .where(
          and(
            eq(workspaces.id, workspaceId),
            isNull(workspaces.ownerUserId),
          ),
        )
        .returning();

      if (!claimed) {
        throw new WorkspaceClaimError();
      }

      await tx.insert(authSessions).values({
        tokenHash: hashSessionToken(token),
        workspaceId: claimed.id,
        userId: account.id,
        expiresAt: sessionExpiresAt,
        lastSeenAt: now,
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
      });

      return { ok: true as const, workspace: claimed, account, token };
    });
  } catch (error) {
    if (error instanceof WorkspaceClaimError) {
      return {
        ok: false,
        code: "already_registered",
        message: "This session already has an account. Sign in instead.",
      };
    }

    const constraint = uniqueViolationConstraint(error);
    if (constraint === "users_email_key") {
      return {
        ok: false,
        code: "email_taken",
        message: "This email is already registered. Try signing in.",
      };
    }
    if (constraint === "workspaces_owner_user_unique") {
      return {
        ok: false,
        code: "already_registered",
        message: "This session already has an account. Sign in instead.",
      };
    }
    throw error;
  }
}

export async function authenticateAccount(
  rawEmail: string,
  password: string,
): Promise<AuthenticateResult> {
  const email = normalizeEmail(rawEmail);

  const [row] = await db
    .select({ user: users, workspace: workspaces })
    .from(users)
    .innerJoin(workspaces, eq(workspaces.ownerUserId, users.id))
    .where(and(eq(users.email, email), isNull(workspaces.deletedAt)))
    .limit(1);

  if (!row) {
    // Equalize timing with a real verification.
    await verifyPassword(password, await getDummyHash());
    return {
      ok: false,
      code: "invalid_credentials",
      message: "Invalid email or password.",
    };
  }

  const valid = await verifyPassword(password, row.user.passwordHash);
  if (!valid) {
    return {
      ok: false,
      code: "invalid_credentials",
      message: "Invalid email or password.",
    };
  }

  if (!row.workspace.isActive) {
    return {
      ok: false,
      code: "inactive",
      message: "This account is disabled.",
    };
  }

  const now = new Date();
  const [workspace] = await db
    .update(workspaces)
    // Logging in reactivates a permanent account whose old guest session had
    // already expired, and ensures the workspace never expires again.
    .set({ expiresAt: null, lastSeenAt: now, deletedAt: null })
    .where(eq(workspaces.id, row.workspace.id))
    .returning();

  await db
    .update(users)
    .set({ lastLoginAt: now, updatedAt: now })
    .where(eq(users.id, row.user.id));

  return {
    ok: true,
    workspace: workspace ?? row.workspace,
    user: {
      id: row.user.id,
      email: row.user.email,
      createdAt: row.user.createdAt,
    },
  };
}
