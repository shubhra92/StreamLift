/**
 * Reads and validates the current auth session inside a Server Action or
 * Route Handler and returns the resolved workspace ID.
 *
 * Returns null when called from a context where the cookie isn't available
 * (e.g. worker-to-server API calls), in which case the caller should skip the
 * workspace filter.
 */
import { getAuthContext } from "./sessionAuth";

export async function getWorkspaceId(): Promise<string | null> {
  const context = await getAuthContext();
  return context?.workspace.id ?? null;
}
