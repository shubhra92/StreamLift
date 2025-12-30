import express from "express";
import progress from "./progress.r.js"
import streamDownload from "./streamDownload.r.js"

const router = express.Router();


router.use("/progress",progress)
router.use("/stream-download", streamDownload)

export default router;
