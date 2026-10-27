"use server";

import { db } from "../db";
import { workers, fileDownloads } from "../db/schema";
import { desc, eq, and, inArray } from "drizzle-orm";
import { encryptCredentials, generateAuthToken } from "../lib/crypto";
import { getGuestId } from "../lib/getGuestId";
import type { Worker } from "../db/schema";
import {
  type TunnelProvider,
  type TunnelConfigMap,
  TUNNEL_PROVIDERS,
  parseTunnelConfig,
  serialiseTunnelConfig,
  getPinggyToken,
  getZrokToken,
  getTunnlGgSshKeyPath,
} from "../lib/tunnelConfig";

const ONLINE_THRESHOLD_MS = 20_000;

// ── Shared input types ────────────────────────────────────────────────────────

export interface WorkerTunnelInput {
  activeTunnelProvider: TunnelProvider;
  /** Pinggy token — required when provider is 'pinggy' */
  pinggyToken?:         string;
  /** zrok account token — required when provider is 'zrok' */
  zrokToken?:           string;
  /** tunnl.gg SSH key path on the worker machine — optional, enables stable URL */
  tunnlggSshKeyPath?:   string;
}

export interface CreateWorkerData extends WorkerTunnelInput {
  name:             string;
  downloadLocation: "local" | "mega";
  computeType:      "low" | "medium" | "high";
  megaEmail?:       string;
  megaSession?:     string; // session JSON minted by the browser — password never sent
}

export interface UpdateWorkerData extends WorkerTunnelInput {
  name?:             string;
  downloadLocation?: "local" | "mega";
  computeType?:      "low" | "medium" | "high";
  megaEmail?:        string;
  megaSession?:      string;
}

// ── Tunnel config helpers ─────────────────────────────────────────────────────

/** Build an encrypted tunnel_config blob from user-supplied form data.
 *  Merges into the existing config so credentials for other providers are preserved.
 */
function buildTunnelConfig(
  input: WorkerTunnelInput,
  existing: TunnelConfigMap = {},
): string {
  const next: TunnelConfigMap = { ...existing };

  // Preserve each provider's credentials independently.
  // Only overwrite a provider's entry if the user explicitly supplied a new value —
  // undefined means "not touched this session, keep existing".
  if (input.pinggyToken?.trim())
    next.pinggy = { token: input.pinggyToken.trim() };

  if (!next.serveo) next.serveo = {};

  // tunnlgg: only update if explicitly passed (even empty string = clear the key path)
  if (input.tunnlggSshKeyPath !== undefined)
    next.tunnlgg = { sshKeyPath: input.tunnlggSshKeyPath.trim() || undefined };
  else if (!next.tunnlgg)
    next.tunnlgg = {};

  if (input.zrokToken?.trim())
    next.zrok = { token: input.zrokToken.trim() };

  return encryptCredentials(serialiseTunnelConfig(next));
}

// ── Actions ───────────────────────────────────────────────────────────────────

export async function createWorker(
  data: CreateWorkerData,
): Promise<{ success: boolean; message?: string; data?: Worker }> {
  const guestId = await getGuestId();
  if (!guestId) return { success: false, message: "Unauthorized" };

  if (!data.name?.trim())
    return { success: false, message: "Worker name is required" };
  if (!["local", "mega"].includes(data.downloadLocation))
    return { success: false, message: "Invalid download location" };
  if (!["low", "medium", "high"].includes(data.computeType))
    return { success: false, message: "Invalid compute type" };
  if (!(TUNNEL_PROVIDERS as readonly string[]).includes(data.activeTunnelProvider))
    return { success: false, message: "Invalid tunnel provider" };
  if (data.activeTunnelProvider === "pinggy" && !data.pinggyToken?.trim())
    return { success: false, message: "Pinggy token is required for the Pinggy tunnel provider" };
  if (data.activeTunnelProvider === "zrok" && !data.zrokToken?.trim())
    return { success: false, message: "zrok account token is required for the zrok tunnel provider" };
  if (data.downloadLocation === "mega" && !data.megaSession)
    return { success: false, message: "Mega login is required for Mega location" };

  // Name uniqueness — scoped to guest
  const [existing] = await db
    .select({ id: workers.id })
    .from(workers)
    .where(and(eq(workers.name, data.name.trim()), eq(workers.guestId, guestId)))
    .limit(1);
  if (existing) return { success: false, message: "A worker with this name already exists" };

  const encryptedTunnelConfig = buildTunnelConfig(data);
  const encryptedSession      = data.megaSession ? encryptCredentials(data.megaSession) : null;
  const authToken             = generateAuthToken();

  const [worker] = await db
    .insert(workers)
    .values({
      guestId:              guestId ?? undefined,
      name:                 data.name.trim(),
      downloadLocation:     data.downloadLocation,
      computeType:          data.computeType,
      megaEmail:            data.megaEmail ?? null,
      megaSession:          encryptedSession,
      activeTunnelProvider: data.activeTunnelProvider,
      tunnelConfig:         encryptedTunnelConfig,
      authToken,
    })
    .returning();

  return { success: true, data: worker };
}

export async function updateWorker(
  workerId: string,
  data: UpdateWorkerData,
): Promise<{ success: boolean; message?: string; data?: Worker }> {
  const guestId = await getGuestId();
  if (!guestId) return { success: false, message: "Unauthorized" };

  const [worker] = await db
    .select()
    .from(workers)
    .where(and(eq(workers.id, workerId), eq(workers.guestId, guestId)))
    .limit(1);
  if (!worker) return { success: false, message: "Worker not found" };

  // Validate only the fields that are being changed
  if (
    data.activeTunnelProvider !== undefined &&
    !(TUNNEL_PROVIDERS as readonly string[]).includes(data.activeTunnelProvider)
  ) return { success: false, message: "Invalid tunnel provider" };

  if (
    data.activeTunnelProvider === "pinggy" &&
    !data.pinggyToken?.trim()
  ) {
    const existingCfg = worker.tunnelConfig
      ? parseTunnelConfig(decryptSafe(worker.tunnelConfig))
      : {};
    if (!getPinggyToken(existingCfg))
      return { success: false, message: "Pinggy token is required for the Pinggy tunnel provider" };
  }

  if (
    data.activeTunnelProvider === "zrok" &&
    !data.zrokToken?.trim()
  ) {
    const existingCfg = worker.tunnelConfig
      ? parseTunnelConfig(decryptSafe(worker.tunnelConfig))
      : {};
    if (!getZrokToken(existingCfg))
      return { success: false, message: "zrok account token is required for the zrok tunnel provider" };
  }

  if (data.name !== undefined) {
    if (!data.name.trim()) return { success: false, message: "Worker name cannot be empty" };
    const [nameTaken] = await db
      .select({ id: workers.id })
      .from(workers)
      .where(
        and(
          eq(workers.name, data.name.trim()),
          eq(workers.guestId, guestId),
        ),
      )
      .limit(1);
    if (nameTaken && nameTaken.id !== workerId)
      return { success: false, message: "A worker with this name already exists" };
  }

  // Decrypt existing tunnel config so we can merge into it
  const existingCfg: TunnelConfigMap = worker.tunnelConfig
    ? parseTunnelConfig(decryptSafe(worker.tunnelConfig))
    : {};

  const encryptedTunnelConfig = buildTunnelConfig(
    {
      activeTunnelProvider: data.activeTunnelProvider ?? (worker.activeTunnelProvider as TunnelProvider) ?? "pinggy",
      pinggyToken:          data.pinggyToken,
      zrokToken:            data.zrokToken,
      tunnlggSshKeyPath:    data.tunnlggSshKeyPath,
    },
    existingCfg,
  );

  const updates: Record<string, unknown> = {
    activeTunnelProvider: data.activeTunnelProvider ?? worker.activeTunnelProvider,
    tunnelConfig:         encryptedTunnelConfig,
    updatedAt:            new Date(),
  };

  if (data.name !== undefined)             updates.name             = data.name.trim();
  if (data.downloadLocation !== undefined) updates.downloadLocation = data.downloadLocation;
  if (data.computeType !== undefined)      updates.computeType      = data.computeType;
  if (data.megaEmail !== undefined)        updates.megaEmail        = data.megaEmail;
  if (data.megaSession !== undefined)
    updates.megaSession = data.megaSession ? encryptCredentials(data.megaSession) : null;

  const [updated] = await db
    .update(workers)
    .set(updates as any)
    .where(eq(workers.id, workerId))
    .returning();

  return { success: true, data: updated };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function decryptSafe(encrypted: string): string {
  try {
    const { decryptCredentials } = require("../lib/crypto");
    return decryptCredentials(encrypted);
  } catch {
    return encrypted; // already plain (legacy rows)
  }
}

// ── Read / delete actions (unchanged) ────────────────────────────────────────

export interface WorkerDeltaSyncResult {
  data: Worker[];
  syncedAt: string;
}

export async function getWorkers(since?: string): Promise<WorkerDeltaSyncResult> {
  const guestId = await getGuestId();
  if (!guestId) return { data: [], syncedAt: new Date().toISOString() };

  const syncedAt = new Date().toISOString();

  const conditions = [eq(workers.guestId, guestId)];
  if (since) {
    const { gte } = await import("drizzle-orm");
    conditions.push(gte(workers.updatedAt, new Date(since)));
  }

  const rows = await db
    .select()
    .from(workers)
    .where(and(...conditions))
    .orderBy(desc(workers.createdAt));

  return { data: rows, syncedAt };
}

export async function getWorkerById(workerId: string) {
  const guestId = await getGuestId();
  if (!guestId) return null;

  const [worker] = await db
    .select()
    .from(workers)
    .where(and(eq(workers.id, workerId), eq(workers.guestId, guestId)))
    .limit(1);

  if (!worker) return null;

  const online = worker.lastHeartbeat
    ? Date.now() - new Date(worker.lastHeartbeat).getTime() < ONLINE_THRESHOLD_MS
    : false;

  return {
    ...worker,
    online,
    lastHeartbeat: worker.lastHeartbeat?.toISOString() ?? null,
  };
}

export async function deleteWorker(
  workerId: string,
): Promise<{ success: boolean; message: string }> {
  const guestId = await getGuestId();
  if (!guestId) return { success: false, message: "Unauthorized" };

  const [worker] = await db
    .select()
    .from(workers)
    .where(and(eq(workers.id, workerId), eq(workers.guestId, guestId)))
    .limit(1);
  if (!worker) return { success: false, message: "Worker not found" };

  const activeDownloads = await db
    .select({ id: fileDownloads.id })
    .from(fileDownloads)
    .where(
      and(
        eq(fileDownloads.workerId, workerId),
        inArray(fileDownloads.status, ["pending", "downloading"]),
      ),
    )
    .limit(1);

  if (activeDownloads.length > 0)
    return { success: false, message: "Cannot delete a worker with active downloads" };

  await db.update(fileDownloads).set({ workerId: null }).where(eq(fileDownloads.workerId, workerId));
  await db.delete(workers).where(eq(workers.id, workerId));

  return { success: true, message: "Worker deleted successfully" };
}
