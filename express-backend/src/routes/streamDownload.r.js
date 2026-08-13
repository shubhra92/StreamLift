import express from "express";
import { streamServerDownload, streamCloudUpload } from "../controllers/streamDownload.js";

const router = express.Router();

router.post("/server", streamServerDownload);
router.post("/cloud", streamCloudUpload);

export default router;
