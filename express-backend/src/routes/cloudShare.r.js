import express from "express";
import { createShareLink, getDownloadInfo } from "../controllers/cloudShare.js";

const router = express.Router();

router.post("/share/:id", createShareLink);
router.get("/download-info/:id", getDownloadInfo);

export default router;
