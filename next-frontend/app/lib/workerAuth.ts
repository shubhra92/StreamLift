import { db } from "../db";
import { workers } from "../db/schema";
import { eq } from "drizzle-orm";
import type { Worker } from "../db/schema";

export async function validateWorkerAuth(
  workerId: string,
  authToken: string
): Promise<{ valid: boolean; worker?: Worker }> {
  const [worker] = await db
    .select()
    .from(workers)
    .where(eq(workers.id, workerId))
    .limit(1);

  if (!worker) return { valid: false };
  if (worker.authToken !== authToken) return { valid: false };

  return { valid: true, worker };
}
