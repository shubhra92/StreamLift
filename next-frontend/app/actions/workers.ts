"use server";

import { db } from "../db";
import { workers, fileDownloads } from "../db/schema";
import { desc, eq, and, inArray } from "drizzle-orm";
import { workerStore, initializeWorkerState } from "../lib/workerStore";
import { encryptCredentials, generateAuthToken } from "../lib/crypto";
import { getGuestId } from "../lib/getGuestId";
import type { Worker } from "../db/schema";

export async function createWorker(data: {
  name: string;
  downloadLocation: "local" | "mega";
  computeType: "low" | "medium" | "high";
  megaEmail?: string;
  megaPassword?: string;
}): Promise<{ success: boolean; message?: string; data?: Worker }> {
  const guestId = await getGuestId();

  if (!data.name?.trim()) {
    return { success: false, message: "Worker name is required" };
  }
  if (!["local", "mega"].includes(data.downloadLocation)) {
    return { success: false, message: "Invalid download location" };
  }
  if (!["low", "medium", "high"].includes(data.computeType)) {
    return { success: false, message: "Invalid compute type" };
  }
  if (data.downloadLocation === "mega" && (!data.megaEmail || !data.megaPassword)) {
    return { success: false, message: "Mega email and password are required for Mega location" };
  }

  // Name uniqueness check — scoped to guest so two guests can use the same name
  const [existing] = await db
    .select({ id: workers.id })
    .from(workers)
    .where(
      guestId
        ? and(eq(workers.name, data.name.trim()), eq(workers.guestId, guestId))
        : eq(workers.name, data.name.trim())
    )
    .limit(1);

  if (existing) {
    return { success: false, message: "A worker with this name already exists" };
  }

  const encryptedPassword = data.megaPassword
    ? encryptCredentials(data.megaPassword)
    : null;

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
      authToken,
    })
    .returning();

  workerStore.set(worker.id, initializeWorkerState(worker.id));

  return { success: true, data: worker };
}

export async function getWorkers() {
  const guestId = await getGuestId();

  const allWorkers = await db
    .select()
    .from(workers)
    .where(guestId ? eq(workers.guestId, guestId) : undefined)
    .orderBy(desc(workers.createdAt));

  return allWorkers.map((w) => {
    const state = workerStore.get(w.id);
    return {
      ...w,
      online: state?.online ?? false,
      ipAddress: state?.ipAddress ?? null,
      lastHeartbeat: state?.lastHeartbeat ?? null,
    };
  });
}

export async function getWorkerById(workerId: string) {
  const guestId = await getGuestId();

  const [worker] = await db
    .select()
    .from(workers)
    .where(
      guestId
        ? and(eq(workers.id, workerId), eq(workers.guestId, guestId))
        : eq(workers.id, workerId)
    )
    .limit(1);

  if (!worker) return null;

  const state = workerStore.get(workerId);

  return {
    ...worker,
    online: state?.online ?? false,
    ipAddress: state?.ipAddress ?? null,
    lastHeartbeat: state?.lastHeartbeat ?? null,
    metrics: state?.metrics ?? null,
    currentTask: state?.currentTask ?? null,
    logs: state?.logs ?? [],
    version: state?.version ?? "1.0.0",
  };
}

export async function deleteWorker(
  workerId: string
): Promise<{ success: boolean; message: string }> {
  const guestId = await getGuestId();

  // Ownership check — guest can only delete their own workers
  const [worker] = await db
    .select()
    .from(workers)
    .where(
      guestId
        ? and(eq(workers.id, workerId), eq(workers.guestId, guestId))
        : eq(workers.id, workerId)
    )
    .limit(1);

  if (!worker) {
    return { success: false, message: "Worker not found" };
  }

  const state = workerStore.get(workerId);
  if (state?.currentTask) {
    return { success: false, message: "Cannot delete a worker with an active download" };
  }

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

  await db
    .update(fileDownloads)
    .set({ workerId: null })
    .where(eq(fileDownloads.workerId, workerId));

  await db.delete(workers).where(eq(workers.id, workerId));
  workerStore.delete(workerId);

  return { success: true, message: "Worker deleted successfully" };
}
