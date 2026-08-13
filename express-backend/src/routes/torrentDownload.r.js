import { Router } from "express";
import { torrentServerDownload, torrentCloudUpload } from "../controllers/torrentDownload.js";
import { getTorrentMetadata } from "../controllers/torrentMetadata.js";

const router = Router();

// POST /api/torrent-download/metadata - Get torrent file list before downloading
router.post("/metadata", getTorrentMetadata);

// POST /api/torrent-download/server - Download torrent to server
router.post("/server", torrentServerDownload);

// POST /api/torrent-download/cloud - Stream torrent to configured cloud provider
router.post("/cloud", torrentCloudUpload);

export default router;
