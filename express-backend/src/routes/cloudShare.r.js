import express from "express";
import { createShareLink, checkCloudFileExists } from "../controllers/cloudShare.js";

const router = express.Router();

router.post("/share/:id", createShareLink);
router.get("/exists/:id", checkCloudFileExists);

export default router;
