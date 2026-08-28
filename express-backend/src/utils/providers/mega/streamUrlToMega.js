import path from "path";
import { progressMap } from "../../progressStore.js";
import { initMega } from "./megaStorage.js";
import { db, fileDownloads } from "../../../db/index.js";
import { eq } from "drizzle-orm";


async function fetchWithRetry(url, retries = 3, timeout = 30000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);
            
            const response = await fetch(url, { 
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            clearTimeout(timeoutId);
            return response;
        } catch (err) {
            console.log(`Fetch attempt ${attempt}/${retries} failed:`, err.message);
            if (attempt === retries) throw err;
            // Wait before retry (exponential backoff)
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
}

/**
 * Find an existing folder by name inside a Mega directory node,
 * or create it if it doesn't exist. Returns the folder node.
 */
async function getOrCreateFolder(parentNode, folderName) {
    const children = Object.values(parentNode.children ?? {});
    const existing = children.find(n => n.directory && n.name === folderName);
    if (existing) return existing;
    return parentNode.mkdir(folderName);
}

export async function streamUrlToMega(id, url, options = { fileName: null, guestId: null }) {
    // Get the initialized mega instance
    const mega = await initMega();
    
    // Ensure storage is ready before proceeding
    if (mega.ready && typeof mega.ready.then === 'function') {
        await mega.ready;
    }

    const response = await fetchWithRetry(url);
    if (!response.ok) {
        const errorData = await response.text()
        await db.update(fileDownloads).set({
            status: "failed",
            errorMessage: errorData,
            updatedAt: new Date(),
        }).where(eq(fileDownloads.id, id))
        
        progressMap.set(id, {
            "downloadedBytes":null,
            "totalBytes":null,
            "percentFixed2": null,
            "percent": null,
            "done": true
        })
        throw new Error(`Download failed with status ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    // Store the full mime type (e.g. "video/mp4"), stripping codec params
    const fileType = contentType.split(";")[0].trim() || null;
    const fileExtension = fileType ? fileType.split("/")[1] ?? null : null;
    const filename = options.fileName
        ?? response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1]
        ?? (fileExtension ? `download.${fileExtension}` : "download");

    // Use null when content-length is absent — 0 would be misleading
    const totalBytes = Number(response.headers.get("content-length")) || null;
    let downloadedBytes = 0;

    // Resolve the upload target node — guest folder when guestId is present, root otherwise
    const uploadTarget = options.guestId
        ? await getOrCreateFolder(mega.root, options.guestId)
        : mega.root;

    const fileStream = uploadTarget.upload({
        name: filename,
        size: totalBytes
    })

    //update db save file detail status from pending to downloading
    await db.update(fileDownloads).set({
        locationPath: filename,
        fileName: filename,
        fileType: fileType,
        status: "downloading",
        fileSize: totalBytes,
        updatedAt: new Date(),
    }).where(eq(fileDownloads.id, id))

    return await new Promise((resolve, reject) => {
        fileStream.on("complete", (file) => {
            console.log("MEGA upload completed ✅");
            console.log("MEGA node ID:", file?.nodeId);

            db.update(fileDownloads).set({
                status: "completed",
                cloudFileHandle: file?.nodeId ?? null,
                updatedAt: new Date(),
            }).where(eq(fileDownloads.id, id))
                .then(() => {
                    progressMap.set(id, {
                        downloadedBytes,
                        totalBytes,
                        percent: 100,
                        percentFixed2: "100.00",  // string — consistent with in-progress format
                        done: true,
                    });
                    resolve(file);
                }).catch(() => {
                    console.log("failed to update db");
                    resolve(file);
                });
        });

        fileStream.on("error", (err) => {
            //update db status
            db.update(fileDownloads).set({
                status: "failed",
                errorMessage: err?.message ?? "check server logs",
                updatedAt: new Date(),
            }).where(eq(fileDownloads.id, id))
                .then(() => {
                    progressMap.set(id, {
                        "done": true
                    });
                    reject(err);
                }).catch(() => {
                    console.log("failed to update db")
                    reject(err);
                })
            // reject(err);
        });

        response.body.pipeTo(
            new WritableStream({
                write(chunk) {
                    downloadedBytes += chunk.length;
                    
                    const progressDetail = {};
                    if (totalBytes) {
                        progressDetail["downloadedBytes"] = downloadedBytes;
                        progressDetail["totalBytes"] = totalBytes;
                        progressDetail["percentFixed2"] = ((downloadedBytes / totalBytes) * 100).toFixed(2);
                        progressDetail["percent"] = Math.round((downloadedBytes / totalBytes) * 100);
                    } else {
                        progressDetail["downloadedBytes"] = downloadedBytes;
                        progressDetail["totalBytes"] = null;
                        progressDetail["percentFixed2"] = null;
                        progressDetail["percent"] = null;
                    }
                    progressMap.set(id, progressDetail);
                    
                    // Return a promise to ensure backpressure - wait for write to complete
                    return new Promise((resolveWrite, rejectWrite) => {
                        const canContinue = fileStream.write(chunk, (err) => {
                            if (err) rejectWrite(err);
                            else resolveWrite();
                        });
                        
                        // If buffer is full, wait for drain
                        if (!canContinue) {
                            fileStream.once('drain', resolveWrite);
                        }
                    });
                },
                close() {
                    fileStream.end();
                    console.log("Download stream ended, waiting for MEGA…");
                },
                abort(err) {
                    fileStream.destroy?.();

                    // db status update
                    db.update(fileDownloads).set({
                        status: "failed",
                        errorMessage: err?.message ?? "check server logs",
                        updatedAt: new Date(),
                    }).where(eq(fileDownloads.id, id))
                        .then(() => {
                            progressMap.set(id, {
                                "done": true
                            });
                            reject(err);
                        }).catch(() => {
                            console.log("failed to update db")
                            reject(err);
                        })
                    // reject(err);
                },
            })
        );


    });

}