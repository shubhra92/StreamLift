/**
 * Workspace Guard
 *
 * Compares the workspace id stored in IDB against the current session
 * workspace id. If they differ (workspace rotation, account switch, cookie reset)
 * the entire IDB cache is cleared so we never show another workspace's data.
 *
 * Call once at app initialisation (e.g. in a top-level client component or
 * the SyncManager init path).
 */

import { getCursor, setCursor, clearAllIDB } from "./IDBStore";

let checked = false;
let verifiedWorkspaceId: string | null = null;
let sessionRequest: Promise<CurrentSession | null> | null = null;
let guardRequest: Promise<string | null> | null = null;

export interface CurrentSession {
  workspaceId: string;
  shortId: string | null;
  isRegistered: boolean;
  email: string | null;
}

/**
 * Fetch the current workspace/session from /api/session/me.
 * Returns null if unauthenticated or the request fails.
 */
export function getCurrentSession(): Promise<CurrentSession | null> {
  if (!sessionRequest) {
    sessionRequest = fetch("/api/session/me", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          // A stale cookie is cleared by /api/session/me. Re-enter through the
          // session bootstrap so the next request gets a fresh anonymous
          // workspace. Auth pages must stay session-free.
          if (typeof window !== "undefined") {
            const { pathname, search } = window.location;
            if (pathname !== "/login" && pathname !== "/register") {
              const returnTo = encodeURIComponent(pathname + search);
              window.location.replace(`/api/session/init?returnTo=${returnTo}`);
            }
          }
          return null;
        }
        const payload = await res.json();
        const workspace = payload?.workspace;
        const guest = payload?.guest;
        const workspaceId = workspace?.id ?? guest?.id;
        if (!workspaceId) return null;
        return {
          workspaceId: workspaceId as string,
          shortId: guest?.shortId ?? null,
          isRegistered: Boolean(
            workspace?.isRegistered ?? guest?.isRegistered,
          ),
          email: typeof payload?.account?.email === "string"
            ? payload.account.email
            : null,
        };
      })
      .catch(() => null);
  }
  return sessionRequest;
}

/**
 * Run the workspace guard check. Safe to call multiple times — only runs once
 * per page lifetime (tracked via the `checked` flag).
 *
 * Returns the current workspace id (or null if unauthenticated).
 */
export async function runWorkspaceGuard(): Promise<string | null> {
  if (guardRequest) return guardRequest;
  if (checked) return verifiedWorkspaceId;

  guardRequest = (async () => {
    const session = await getCurrentSession();
    if (!session) return null;
    const currentWorkspaceId = session.workspaceId;

    // Migrate the legacy cursor key once, then never read it again.
    const cachedWorkspaceId =
      (await getCursor("workspace_id")) ??
      (await getCursor("guest_id"));

    if (cachedWorkspaceId && cachedWorkspaceId !== currentWorkspaceId) {
      console.info("[IDB] Workspace rotation detected — clearing cache");
      await clearAllIDB();
    }

    await setCursor("workspace_id", currentWorkspaceId);
    verifiedWorkspaceId = currentWorkspaceId;
    checked = true;
    return currentWorkspaceId;
  })();

  return guardRequest;
}

/** Reset the guard flag (for testing or explicit re-initialisation). */
export function resetWorkspaceGuard(): void {
  checked = false;
  verifiedWorkspaceId = null;
  sessionRequest = null;
  guardRequest = null;
}
