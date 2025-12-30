import fs from "fs";
import path from "path";
import { progressMap } from "./progressStore.js";

export async function serverDownloadWithProgress(id, url) {

    const response = await fetch(url);
    if (!response.ok) {
        return res.status(400).json({ details: "Download failed" });
    }

    const [fileType, fileExtention] = response.headers.get("content-type")?.split("/")
    const filename = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `movie.${fileExtention}`

    const filePath = path.join("downloads", filename);

    const totalBytes = Number(response.headers.get("content-length")) || 0;
    let downloadedBytes = 0;

    const fileStream = fs.createWriteStream(filePath);

    return await new Promise((resolve, reject) => {
        response.body.pipeTo(
            new WritableStream({
                write(chunk) {
                    downloadedBytes += chunk.length;
                    fileStream.write(chunk);

                    const progressDetail = {}

                    if (totalBytes) {
                        const percent = (
                            (downloadedBytes / totalBytes) * 100
                        ).toFixed(2);

                        progressDetail["downloadedBytes"] = downloadedBytes
                        progressDetail["totalBytes"] = totalBytes
                        progressDetail["percentFixed2"] = percent
                        progressDetail["percent"] = totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : null;

                        // console.log(`Downloading: ${percent}% (${downloadedBytes}/${totalBytes} bytes)`);
                    } else {
                        progressDetail["downloadedBytes"] = downloadedBytes
                        progressDetail["totalBytes"] = null
                        progressDetail["percentFixed2"] = null
                        progressDetail["percent"] = null

                        // console.log(`Downloaded: ${downloadedBytes} bytes`);
                    }
                    progressMap.set(id, progressDetail);
                },
                close() {
                    fileStream.end();
                    console.log("Download completed ✅");
                    progressMap.set(id, {
                        "downloadedBytes": downloadedBytes,
                        "percent": 100,
                        "percentFixed2": 100.00,
                         "done": true
                    });
                    resolve();
                },
                abort(err) {
                    reject(err);
                },
            })
        );
    });
}