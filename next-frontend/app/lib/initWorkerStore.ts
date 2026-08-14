/**
 * initWorkerStore — no-op stub kept so existing imports don't break.
 *
 * The old in-memory Map + offline checker have been removed.
 * Worker state is now read directly from the DB on each request.
 */
export async function initWorkerStore(): Promise<void> {
  // Nothing to initialise — DB is the source of truth now.
}
