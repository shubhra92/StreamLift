"use server";

import { db } from "../db";
import { workers, fileDownloads } from "../db/schema";
import { desc, eq, and, inArray } from "drizzle-orm";
import { encryptCredentials, generateAuthToken } from "../lib/crypto";
import { getGuestId } from "../lib/getGuestId";
import type { Worker } from "../db/schema";

const ONLINE_THRESHOLD_MS = 20_000;

export async function createWorker(data: {
  name: string;
  downloadLocation: "local" | "mega";
  computeType: "low" | "medium" | "high";
  pinggyToken: string;
  megaEmail?: string;
  megaPassword?: string;
}): Promise<{ success: boolean; message?: string; data?: Worker }> {
  const guestId = await getGuestId();

  if (!guestId) return { success: false, message: "Unauthorized" };

  if (!data.name?.trim()) return { success: false, message: "Worker name is required" };
  if (!["local", "mega"].includes(data.downloadLocation))
    return { success: false, message: "Invalid download location" };
  if (!["low", "medium", "high"].includes(data.computeType))
    return { success: false, message: "Invalid compute type" };
  if (!data.pinggyToken?.trim())
    return { success: false, message: "Pinggy token is required" };
  if (data.downloadLocation === "mega" && (!data.megaEmail || !data.megaPassword))
    return { success: false, message: "Mega email and password are required for Mega location" };

  // Name uniqueness — scoped to guest
  const [existing] = await db
    .select({ id: workers.id })
    .from(workers)
    .where(and(eq(workers.name, data.name.trim()), eq(workers.guestId, guestId)))
    .limit(1);

  if (existing) return { success: false, message: "A worker with this name already exists" };

  const encryptedPassword    = data.megaPassword  ? encryptCredentials(data.megaPassword)  : null;
  const encryptedPinggyToken = data.pinggyToken   ? encryptCredentials(data.pinggyToken)   : null;
  const authToken = generateAuthToken();

  const [worker] = await db
    .insert(workers)
    .values({
      guestId: guestId ?? undefined,
      name: data.name.trim(),
      downloadLocation: data.downloadLocation,
      computeType: data.computeType,
      megaEmail: data.megaEmail ?? null,
      megaPassword: encryptedPassword,
      pinggyToken: encryptedPinggyToken,
      authToken,
    })
    .returning();

  return { success: true, data: worker };
}

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

  // Derive online status from DB last_heartbeat — no in-memory store
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
  workerId: string
): Promise<{ success: boolean; message: string }> {
  const guestId = await getGuestId();
  if (!guestId) return { success: false, message: "Unauthorized" };

  const [worker] = await db
    .select()
    .from(workers)
    .where(and(eq(workers.id, workerId), eq(workers.guestId, guestId)))
    .limit(1);

  if (!worker) return { success: false, message: "Worker not found" };

  // Check for active downloads in DB
  const activeDownloads = await db
    .select({ id: fileDownloads.id })
    .from(fileDownloads)
    .where(
      and(
        eq(fileDownloads.workerId, workerId),
        inArray(fileDownloads.status, ["pending", "downloading"])
      )
    )
    .limit(1);

  if (activeDownloads.length > 0) {
    return { success: false, message: "Cannot delete a worker with active downloads" };
  }

  await db.update(fileDownloads).set({ workerId: null }).where(eq(fileDownloads.workerId, workerId));
  await db.delete(workers).where(eq(workers.id, workerId));

  return { success: true, message: "Worker deleted successfully" };
}
