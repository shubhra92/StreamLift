import express from "express";
import { getProgressUpdateById, getStremProgressUpdateById } from "../controllers/progress.c.js";

const router = express.Router();

// Polling endpoint - frontend calls this repeatedly
router.get("/:id", getProgressUpdateById);

// SSE endpoint (keep for backward compatibility, but may timeout on Render)
router.get("/:id/stream", getStremProgressUpdateById);

export default router;
