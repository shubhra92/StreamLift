import express from "express";
import { progressMap } from "../utils/progressStore.js";

const router = express.Router();

// Polling endpoint - frontend calls this repeatedly
router.get("/:id", async (req, res) => {
    const { id } = req.params;
    const progress = progressMap.get(id);

    if (!progress) {
        return res.status(404).json({ error: "Progress not found", id });
    }

    res.json(progress);

    // Clean up completed downloads after response
    if (progress.done) {
        setTimeout(() => progressMap.delete(id), 60000); // Keep for 1 min after done
    }
});

// SSE endpoint (keep for backward compatibility, but may timeout on Render)
router.get("/:id/stream", async (req, res) => {
    const { id } = req.params;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const interval = setInterval(() => {
        const progress = progressMap.get(id);

        if (progress) {
            res.write(`data: ${JSON.stringify(progress)}\n\n`);

            if (progress.done) {
                clearInterval(interval);
                res.end();
            }
        }
    }, 500);

    req.on("close", () => {
        clearInterval(interval);
    });
});

export default router;
