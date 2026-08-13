import { progressMap } from "../utils/progressStore.js";
import { serverTorrentDownload } from "../utils/serverTorrentDownload.js";
import { getCloudUploadFns } from "../utils/cloudProvider.js";
import { db, fileDownloads } from "../db/index.js";
import { eq } from "drizzle-orm";

export async function torrentServerDownload(req, res) {
    try {
        const { magnet_link, file_name, file_id } = req.body;
        let { file_indices } = req.body;

        if (!magnet_link) {
            return res.status(400).send({ status: false, message: "magnet_link is required" });
        }

        if (!magnet_link.startsWith('magnet:?')) {
            return res.status(400).send({ status: false, message: "Invalid magnet link format" });
        }

        if (progressMap.get(file_id)) {
            return res.status(200).send({
                status: true,
                message: "torrent download already started",
                data: { fileStatusId: file_id }
            });
        }

        let data = null;

        if (file_id) {
            [data] = await db.select().from(fileDownloads).where(eq(fileDownloads.id, file_id)).limit(1);

            // Use stored file_indices from DB if not provided in request
            if (data && !file_indices && data.selectedFileIndices) {
                file_indices = JSON.parse(data.selectedFileIndices);
                console.log(`📋 Using stored file indices: ${file_indices}`);
            }
        }

        // Only create a new record if no existing record was found
        if (!file_id || !data) {
            [data] = await db.insert(fileDownloads).values({
                location: "server",
                sourceUrl: magnet_link,
                downloadType: "torrent",
                selectedFileIndices: file_indices ? JSON.stringify(file_indices) : null,
                ...(file_name && { fileName: file_name })
            }).returning();
        }

        const id = data.id;
        const guestId = data.guestId ?? null;

        progressMap.set(id, {
            downloadedBytes: 0,
            totalBytes: data.fileSize ?? null,
            percentFixed2: null,
            percent: null,
        });

        const resolvedFileName = data.fileName || file_name;

        serverTorrentDownload(id, magnet_link, {
            fileName: resolvedFileName,
            fileIndices: file_indices,
            guestId
        }).catch(console.error);

        return res.status(200).send({
            status: true,
            message: "torrent download started successfully",
            data: { fileStatusId: id }
        });
    } catch (error) {
        console.error("Error in torrentServerDownload:", error);
        return res.status(500).send({ status: false, details: error.message });
    }
}

export async function torrentCloudUpload(req, res) {
    try {
        const { magnet_link, file_name, file_id } = req.body;
        let { file_indices } = req.body;

        if (!magnet_link) {
            return res.status(400).send({ status: false, message: "magnet_link is required" });
        }

        if (!magnet_link.startsWith('magnet:?')) {
            return res.status(400).send({ status: false, message: "Invalid magnet link format" });
        }

        if (progressMap.get(file_id)) {
            return res.status(200).send({
                status: true,
                message: "torrent download already started",
                data: { fileStatusId: file_id }
            });
        }

        let data = null;

        if (file_id) {
            [data] = await db.select().from(fileDownloads).where(eq(fileDownloads.id, file_id)).limit(1);

            // Use stored file_indices from DB if not provided in request
            if (data && !file_indices && data.selectedFileIndices) {
                file_indices = JSON.parse(data.selectedFileIndices);
                console.log(`📋 Using stored file indices: ${file_indices}`);
            }
        }

        // Only create a new record if no existing record was found
        if (!file_id || !data) {
            [data] = await db.insert(fileDownloads).values({
                location: "cloud",
                sourceUrl: magnet_link,
                downloadType: "torrent",
                selectedFileIndices: file_indices ? JSON.stringify(file_indices) : null,
                ...(file_name && { fileName: file_name })
            }).returning();
        }

        const id = data.id;
        const guestId = data.guestId ?? null;

        progressMap.set(id, {
            downloadedBytes: 0,
            totalBytes: data.fileSize ?? null,
            percentFixed2: null,
            percent: null,
        });

        const resolvedFileName = data.fileName || file_name;

        // Resolve the provider at runtime via STORAGE_PROVIDER env var
        const { streamTorrentToCloud } = await getCloudUploadFns();
        streamTorrentToCloud(id, magnet_link, {
            fileName: resolvedFileName,
            fileIndices: file_indices,
            guestId
        }).catch(console.error);

        return res.status(200).send({
            status: true,
            message: "torrent to cloud upload started successfully",
            data: { fileStatusId: id }
        });
    } catch (error) {
        console.error("Error in torrentCloudUpload:", error);
        return res.status(500).send({ status: false, details: error.message });
    }
}
