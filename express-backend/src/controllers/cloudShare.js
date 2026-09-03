import { initMega } from "../utils/providers/mega/megaStorage.js";
import { File } from "megajs";
import { db, fileDownloads } from "../db/index.js";
import { eq } from "drizzle-orm";

/**
 * Find a file node by its nodeId inside the MEGA tree.
 */
function findNodeByHandle(node, targetId) {
  if (node.nodeId === targetId) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeByHandle(child, targetId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Check whether a MEGA share URL still resolves to an existing node.
 *
 * Uses megajs's shared-file loader (File.fromURL + loadAttributes), which issues
 * the raw `a:g` request MEGA's API expects. For a node deleted after its share
 * link was created, loadAttributes rejects (ENOENT / -9), which we treat as
 * "missing". A valid load (or a transient network/timeout failure) is treated as
 * "node exists" so we never wrongly flag a healthy file as deleted.
 */
async function checkMegaNodeMissing(shareUrl) {
  const handle = shareUrl.match(/\/file\/([^#?]+)/)?.[1];
  if (!handle) return false;
  try {
    const sharedFile = File.fromURL(shareUrl);
    sharedFile.api.userAgent = "StreamLift (+https://streamlift.app)";
    // Guard against a never-settling loadAttributes so a flaky MEGA response
    // never ties up the request.
    await Promise.race([
      sharedFile.loadAttributes(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("MEGA check timed out")), 8000)),
    ]);
    return false;
  } catch (err) {
    // ENOENT (-9) from loadAttributes means the node no longer exists. Any other
    // failure (timeout, network) resolves to "exists" to avoid false deletions.
    return /ENOENT|not found|Node.*not found|\(-9\)/i.test(String(err?.message ?? ""));
  }
}

/**
 * POST /api/cloud/share/:id
 * Create a MEGA share link for a completed cloud upload.
 */
export async function createShareLink(req, res) {
  try {
    const { id } = req.params;

    const [row] = await db.select().from(fileDownloads).where(eq(fileDownloads.id, id)).limit(1);
    if (!row) return res.status(404).json({ error: "Download not found" });
    if (row.status !== "completed") return res.status(400).json({ error: "Download not completed" });
    if (!row.cloudFileHandle) return res.status(400).json({ error: "No cloud node handle — upload may not have completed on this server" });

    if (row.cloudShareUrl) return res.status(200).json({ shareUrl: row.cloudShareUrl });

    const mega = await initMega();
    if (mega.ready && typeof mega.ready.then === "function") await mega.ready;

    const fileNode = findNodeByHandle(mega.root, row.cloudFileHandle);
    if (!fileNode) {
      // The node no longer exists in MEGA. Clear both the handle and any stale
      // share URL so the row stops showing cloud actions.
      await db
        .update(fileDownloads)
        .set({ cloudFileHandle: null, cloudShareUrl: null, updatedAt: new Date() })
        .where(eq(fileDownloads.id, id));
      return res.status(404).json({ error: "File not found in Cloud" });
    }

    const shareUrl = await fileNode.link();

    await db.update(fileDownloads).set({ cloudShareUrl: shareUrl, updatedAt: new Date() }).where(eq(fileDownloads.id, id));

    return res.status(200).json({ shareUrl });
  } catch (err) {
    console.error("createShareLink error:", err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/cloud/exists/:id
 *
 * Authoritative check of whether a completed cloud upload's MEGA node still
 * exists. Used by the frontend when a download click hits a file that may have
 * been deleted directly from MEGA after its share link was created.
 *
 * When the node is gone, we null out cloudShareUrl so the UI stops offering the
 * (now broken) download buttons and only the delete icon remains.
 *
 * Only the download :id is sent (never the share URL in the body). We check the
 * node with megajs's shared-file loader against the public API instead of
 * reloading the whole cached MEGA tree, so an in-flight upload/download is never
 * disturbed.
 */
export async function checkCloudFileExists(req, res) {
  try {
    const { id } = req.params;

    const [row] = await db.select().from(fileDownloads).where(eq(fileDownloads.id, id)).limit(1);
    if (!row) return res.status(404).json({ error: "Download not found" });

    if (!row.cloudShareUrl && !row.cloudFileHandle) {
      return res.json({ exists: false });
    }

    // Primary authoritative check: resolve the share URL with megajs. For a node
    // deleted after its share link was created, loadAttributes rejects (ENOENT /
    // -9), which we treat as missing. This matches the signal the frontend sees.
    if (row.cloudShareUrl) {
      const isMissing = await checkMegaNodeMissing(row.cloudShareUrl);
      if (isMissing) {
        await db
          .update(fileDownloads)
          .set({ cloudShareUrl: null, cloudFileHandle: null, updatedAt: new Date() })
          .where(eq(fileDownloads.id, id));
        return res.json({ exists: false });
      }
      return res.json({ exists: true });
    }

    // Fallback (no usable share URL): look the handle up in the cached tree.
    if (row.cloudFileHandle) {
      const mega = await initMega();
      if (mega.ready && typeof mega.ready.then === "function") await mega.ready;
      const fileNode = findNodeByHandle(mega.root, row.cloudFileHandle) || null;
      if (fileNode) return res.json({ exists: true });
    }

    await db
      .update(fileDownloads)
      .set({ cloudShareUrl: null, cloudFileHandle: null, updatedAt: new Date() })
      .where(eq(fileDownloads.id, id));

    return res.json({ exists: false });
  } catch (err) {
    console.error("checkCloudFileExists error:", err);
    return res.status(500).json({ error: err.message });
  }
}
