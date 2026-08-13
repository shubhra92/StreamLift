import { progressMap } from "../utils/progressStore.js";
import { serverDownloadWithProgress } from "../utils/serverDownloadWithProgress.js";
import { getCloudUploadFns } from "../utils/cloudProvider.js";
import { db, fileDownloads } from "../db/index.js";
import { eq } from "drizzle-orm";

export async function streamServerDownload(req, res) {
    try {
        const { source_url, file_name, file_id } = req.body;

        // file_id is required — the row is always created by Next.js createDownload first
        if (!file_id) {
            return res.status(400).send({ details: "file_id is required" });
        }

        // Idempotency: if this download is already in progress, return early
        if (progressMap.get(file_id)) {
            return res.status(200).send({
                status: true,
                message: "file download already started",
                data: { fileStatusId: file_id }
            });
        }

        // Validate the row exists — reject unknown IDs rather than silently creating rows
        const [data] = await db.select().from(fileDownloads).where(eq(fileDownloads.id, file_id)).limit(1);
        if (!data) {
            return res.status(404).send({ details: "Download record not found" });
        }

        const id = data.id;
        const guestId = data.guestId ?? null;

        progressMap.set(id, {
            downloadedBytes: 0,
            totalBytes: null,
            percentFixed2: null,
            percent: null,
        });

        serverDownloadWithProgress(id, source_url, { fileName: file_name, guestId }).catch(console.error);

        return res.status(200).send({
            status: true,
            message: "message succesful recived",
            data: { fileStatusId: id }
        });
    } catch (error) {
        return res.status(500).send({ details: error.message });
    }
}

export async function streamCloudUpload(req, res) {
    try {
        const { source_url, file_name, file_id } = req.body;

        // file_id is required — the row is always created by Next.js createDownload first
        if (!file_id) {
            return res.status(400).send({ details: "file_id is required" });
        }

        // Idempotency: if this download is already in progress, return early
        if (progressMap.get(file_id)) {
            return res.status(200).send({
                status: true,
                message: "file download already started",
                data: { fileStatusId: file_id }
            });
        }

        // Validate the row exists — reject unknown IDs rather than silently creating rows
        const [data] = await db.select().from(fileDownloads).where(eq(fileDownloads.id, file_id)).limit(1);
        if (!data) {
            return res.status(404).send({ details: "Download record not found" });
        }

        const id = data.id;
        const guestId = data.guestId ?? null;

        progressMap.set(id, {
            downloadedBytes: 0,
            totalBytes: null,
            percentFixed2: null,
            percent: null,
        });

        // Resolve the provider at runtime via STORAGE_PROVIDER env var
        const { streamUrlToCloud } = await getCloudUploadFns();
        streamUrlToCloud(id, source_url, { fileName: file_name, guestId }).catch(console.error);

        return res.status(200).send({
            status: true,
            message: "message succesful recived",
            data: { fileStatusId: id }
        });
    } catch (error) {
        return res.status(500).send({ details: error.message });
    }
}
