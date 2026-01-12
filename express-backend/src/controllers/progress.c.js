import { progressMap } from "../utils/progressStore.js";

export async function getProgressUpdateById(req, res) {
    const { id } = req.params;

    const progress = progressMap.get(id);
    if (!progress) {
        return res.status(404).json({ details: "Progress not found", fileId: id });
    }

    res.json(progress);

    // Clean up completed downloads after response
    if (progress.done) {
        setTimeout(() => progressMap.delete(id), 60000); // Keep for 1 min after done
    }
}

export async function getStremProgressUpdateById(req, res) {
    const { id } = req.params;

    let isGetDataFistTime = true;
    let progress = progressMap.get(id);
    if (!progress) {
        return res.status(404).json({ details: "Progress not found", fileId: id });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const interval = setInterval(() => {
        if (!isGetDataFistTime) {
            progress = progressMap.get(id);
        } else {
            isGetDataFistTime = false;
        }

        if (progress) {
            res.write(`data: ${JSON.stringify(progress)}\n\n`);

            if (progress.done) {
                clearInterval(interval);
                res.end();
            }
        }
    }, 1000);

    req.on("close", () => {
        clearInterval(interval);
    });
}