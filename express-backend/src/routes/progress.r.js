import express from "express";
import { progressMap } from "../utils/progressStore.js";

const router = express.Router();

router.get("/:id", async (req, res) => {
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
