import path from "path";
import { progressMap } from "./progressStore.js";
import { mega } from "./megaStorage.js";


export async function  streamUrlToMega(id, url) {

    const response = await fetch(url);
    if (!response.ok) {
        return res.status(400).json({ details: "Download failed" });
    }

    const [fileType, fileExtention] = response.headers.get("content-type")?.split("/")
    const filename = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `movie.${fileExtention}`

    const filePath = path.join("downloads", filename);

    const totalBytes = Number(response.headers.get("content-length")) || 0;
    let downloadedBytes = 0;

    const fileStream = mega.upload({
        name: filename,
        size: totalBytes
    })

    return await new Promise((resolve, reject) => {
        fileStream.on("complete", (file) => {
            console.log("MEGA upload completed ✅");
            progressMap.set(id, {
                downloadedBytes,
                totalBytes,
                percent: 100,
                percentFixed2: 100.0,
                done: true,
            });
            resolve(file);
        });

        fileStream.on("error", (err) => {
            reject(err);
        });

        response.body.pipeTo(
            new WritableStream({
                write(chunk) {
                    downloadedBytes += chunk.length;
                    
                    // Update progress tracking
                    const progressDetail = {};
                    if (totalBytes) {
                        const percent = ((downloadedBytes / totalBytes) * 100).toFixed(2);
                        progressDetail["downloadedBytes"] = downloadedBytes;
                        progressDetail["totalBytes"] = totalBytes;
                        progressDetail["percentFixed2"] = percent;
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
                    reject(err);
                },
            })
        );


    });

}