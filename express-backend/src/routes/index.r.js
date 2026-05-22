import express from "express";
import progress from "./progress.r.js"
import streamDownload from "./streamDownload.r.js"
import torrentDownload from "./torrentDownload.r.js"

const router = express.Router();


router.use("/progress", progress)
router.use("/stream-download", streamDownload)
router.use("/torrent-download", torrentDownload)

export default router;
