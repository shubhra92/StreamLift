import path from "path";
import { progressMap } from "./progressStore.js";
import { initMega } from "./megaStorage.js";


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

export async function streamUrlToMega(id, url) {
    // Get the initialized mega instance
    const mega = await initMega();
    
    // Ensure storage is ready before proceeding
    if (mega.ready && typeof mega.ready.then === 'function') {
        await mega.ready;
    }

    const response = await fetchWithRetry(url);
    if (!response.ok) {
        throw new Error(`Download failed with status ${response.status}`);
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