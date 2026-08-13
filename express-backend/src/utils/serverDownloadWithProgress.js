import fs from "fs";
import path from "path";
import { progressMap } from "./progressStore.js";
import { db, fileDownloads } from "../db/index.js";
import { eq } from "drizzle-orm";

const isServerDownloadEnabled = process.env.SERVER_DOWNLOAD_ENABLED ?? false


export async function serverDownloadWithProgress(id, url, options = { fileName: null, guestId: null }) {

    if(isServerDownloadEnabled !== "true"){
         await db.update(fileDownloads).set({
            status: "failed",
            errorMessage: "server download not available",
            updatedAt: new Date(),
        }).where(eq(fileDownloads.id, id))

        progressMap.set(id, {
            "downloadedBytes":null,
            "totalBytes":null,
            "percentFixed2": null,
            "percent": null,
            "done": true
        })

        return null
    }

    const response = await fetch(url);
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
    // Derive extension from the subtype portion
    const fileExtension = fileType ? fileType.split("/")[1] ?? null : null;
    const filename = options.fileName
        ?? response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1]
        ?? (fileExtension ? `download.${fileExtension}` : "download");

    // Scope the download folder to the guest when a guestId is available
    const downloadDir = options.guestId
        ? path.join("downloads", options.guestId)
        : path.join("downloads");

    fs.mkdirSync(downloadDir, { recursive: true });

    const filePath = path.join(downloadDir, filename);

    // Use null when content-length is absent — 0 would be misleading
    const totalBytes = Number(response.headers.get("content-length")) || null;
    let downloadedBytes = 0;

    const fileStream = fs.createWriteStream(filePath);

    // Update DB: set status to downloading with known metadata
    await db.update(fileDownloads).set({
        locationPath: filePath,
        fileName: filename,
        fileType: fileType,
        status: "downloading",
        fileSize: totalBytes,
        updatedAt: new Date(),
    }).where(eq(fileDownloads.id, id))

    return await new Promise((resolve, reject) => {
        response.body.pipeTo(
            new WritableStream({
                write(chunk) {
                    downloadedBytes += chunk.length;
                    fileStream.write(chunk);

                    const progressDetail = {};
                    if (totalBytes) {
                        const percent = Math.round((downloadedBytes / totalBytes) * 100);
                        progressDetail["downloadedBytes"] = downloadedBytes;
                        progressDetail["totalBytes"] = totalBytes;
                        progressDetail["percentFixed2"] = ((downloadedBytes / totalBytes) * 100).toFixed(2);
                        progressDetail["percent"] = percent;
                    } else {
                        progressDetail["downloadedBytes"] = downloadedBytes;
                        progressDetail["totalBytes"] = null;
                        progressDetail["percentFixed2"] = null;
                        progressDetail["percent"] = null;
                    }
                    progressMap.set(id, progressDetail);
                },
                close() {
                    fileStream.end();
                    console.log("Download completed ✅");

                    db.update(fileDownloads).set({
                        status: "completed",
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
                        resolve();
                    }).catch(() => {
                        console.log("DB update failed");
                        resolve();
                    });
                },
                abort(err) {
                    db.update(fileDownloads).set({
                        status: "failed",
                        errorMessage: err?.message ?? "check server logs",
                        updatedAt: new Date(),
                    }).where(eq(fileDownloads.id, id))
                    .then(()=>{
                        progressMap.set(id, {
                            "done": true
                        });
                        reject(err);
                    }).catch(()=>{
                        console.log("DB update failed");
                        reject(err);
                    })
                    // reject(err);
                },
            })
        );
    });
}