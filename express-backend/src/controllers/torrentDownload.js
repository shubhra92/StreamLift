import { progressMap } from "../utils/progressStore.js";
import { serverTorrentDownload } from "../utils/serverTorrentDownload.js";
import { streamTorrentToMega } from "../utils/streamTorrentToMega.js";
import { db, fileDownloads } from "../db/index.js";
import { eq } from "drizzle-orm";

export async function torrentServerDownload(req, res) {
    try {
        const { magnet_link, file_name, file_id, file_indices } = req.body;

        if (!magnet_link) {
            return res.status(400).send({
                status: false,
                message: "magnet_link is required"
            });
        }

        // Validate magnet link format
        if (!magnet_link.startsWith('magnet:?')) {
            return res.status(400).send({
                status: false,
                message: "Invalid magnet link format"
            });
        }

        if (progressMap.get(file_id)) {
            return res.status(200).send({
                status: true,
                message: "torrent download already started",
                data: {
                    fileStatusId: file_id
                }
            });
        }

        let data = null;

        if (file_id) {
            [data] = await db.select().from(fileDownloads).where(eq(fileDownloads.id, file_id)).limit(1);
            
            // If file_id exists, use stored file_indices if not provided in request
            if (data && !file_indices && data.selectedFileIndices) {
                file_indices = JSON.parse(data.selectedFileIndices);
                console.log(`📋 Using stored file indices: ${file_indices}`);
            }
        }
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

        const progressDetail = {
            "downloadedBytes": 0,
            "totalBytes": null,
            "percentFixed2": null,
            "percent": null,
        };

        progressMap.set(id, progressDetail);

        serverTorrentDownload(id, magnet_link, { 
            fileName: file_name,
            fileIndices: file_indices 
        }).catch(console.error);

        return res.status(200).send({
            status: true,
            message: "torrent download started successfully",
            data: {
                fileStatusId: id
            }
        });
    } catch (error) {
        console.error("Error in torrentServerDownload:", error);
        return res.status(500).send({
            status: false,
            details: error.message
        });
    }
}

export async function torrentMegaUpload(req, res) {
    try {
        const { magnet_link, file_name, file_id, file_indices } = req.body;

        if (!magnet_link) {
            return res.status(400).send({
                status: false,
                message: "magnet_link is required"
            });
        }

        // Validate magnet link format
        if (!magnet_link.startsWith('magnet:?')) {
            return res.status(400).send({
                status: false,
                message: "Invalid magnet link format"
            });
        }

        if (progressMap.get(file_id)) {
            return res.status(200).send({
                status: true,
                message: "torrent download already started",
                data: {
                    fileStatusId: file_id
                }
            });
        }

        let data = null;

        if (file_id) {
            [data] = await db.select().from(fileDownloads).where(eq(fileDownloads.id, file_id)).limit(1);
            
            // If file_id exists, use stored file_indices if not provided in request
            if (data && !file_indices && data.selectedFileIndices) {
                file_indices = JSON.parse(data.selectedFileIndices);
                console.log(`📋 Using stored file indices: ${file_indices}`);
            }
        }
        if (!file_id || !data) {
            [data] = await db.insert(fileDownloads).values({
                location: "mega",
                sourceUrl: magnet_link,
                downloadType: "torrent",
                selectedFileIndices: file_indices ? JSON.stringify(file_indices) : null,
                ...(file_name && { fileName: file_name })
            }).returning();
        }

        const id = data.id;

        const progressDetail = {
            "downloadedBytes": 0,
            "totalBytes": null,
            "percentFixed2": null,
            "percent": null,
        };
        
        progressMap.set(id, progressDetail);

        streamTorrentToMega(id, magnet_link, { 
            fileName: file_name,
            fileIndices: file_indices 
        }).catch(console.error);

        return res.status(200).send({
            status: true,
            message: "torrent to MEGA upload started successfully",
            data: {
                fileStatusId: id
            }
        });

    } catch (error) {
        console.error("Error in torrentMegaUpload:", error);
        return res.status(500).send({
            status: false,
            details: error.message
        });
    }
}
