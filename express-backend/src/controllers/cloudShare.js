import { initMega } from "../utils/providers/mega/megaStorage.js";
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
    if (!fileNode) return res.status(404).json({ error: "File not found in MEGA storage" });

    const shareUrl = await fileNode.link();

    await db.update(fileDownloads).set({ cloudShareUrl: shareUrl, updatedAt: new Date() }).where(eq(fileDownloads.id, id));

    return res.status(200).json({ shareUrl });
  } catch (err) {
    console.error("createShareLink error:", err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/cloud/download-url/:id
 * Return file metadata (name, size) and share URL for frontend-initiated downloads.
 */
export async function getDownloadInfo(req, res) {
  try {
    const { id } = req.params;

    const [row] = await db.select().from(fileDownloads).where(eq(fileDownloads.id, id)).limit(1);
    if (!row) return res.status(404).json({ error: "Download not found" });
    if (row.status !== "completed") return res.status(400).json({ error: "Download not completed" });

    if (!row.cloudShareUrl) return res.status(400).json({ error: "No share link — click Create Link first" });

    return res.status(200).json({
      shareUrl: row.cloudShareUrl,
      fileName: row.fileName,
      fileSize: row.fileSize,
    });
  } catch (err) {
    console.error("getDownloadInfo error:", err);
    return res.status(500).json({ error: err.message });
  }
}
