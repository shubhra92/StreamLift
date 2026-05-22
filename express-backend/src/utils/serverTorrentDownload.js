import WebTorrent from "webtorrent";
import fs from "fs";
import path from "path";
import { progressMap } from "./progressStore.js";
import { db, fileDownloads } from "../db/index.js";
import { eq } from "drizzle-orm";

const client = new WebTorrent();

export async function serverTorrentDownload(id, magnetLink, options = { fileName: null, fileIndices: null }) {
    const downloadDir = path.join(process.cwd(), 'downloads');
    
    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
        console.log(`🧲 Starting torrent download to server for ID: ${id}`);
        
        let progressInterval = null;
        let torrentInstance = null;
        let executionTriggered = false;

        const pipelineCleanup = async ({ status, errorMessage = null, finalProgress = null }) => {
            if (progressInterval) {
                clearInterval(progressInterval);
                progressInterval = null;
            }

            try {
                await db.update(fileDownloads).set({
                    status,
                    errorMessage,
                    updatedAt: new Date(),
                }).where(eq(fileDownloads.id, id));
                console.log(`💾 Database synced state status: = ${status}`);
            } catch (dbErr) {
                console.error("⚠️ Failed to update database status during cleanup:", dbErr);
            }

            if (finalProgress) {
                progressMap.set(id, finalProgress);
            } else {
                progressMap.set(id, { done: true });
            }

            if (torrentInstance) {
                const targetToDestroy = torrentInstance;
                torrentInstance = null;
                process.nextTick(() => {
                    try {
                        if (targetToDestroy && typeof targetToDestroy.destroy === 'function') {
                            targetToDestroy.destroy({ destroyStore: false }); 
                            console.log("🔌 WebTorrent instance closed down safely (files preserved).");
                        }
                    } catch (e) {
                        console.error("Error cleaning up downloading instance context:", e);
                    }
                });
            }
        };

        client.add(magnetLink, { path: downloadDir }, (torrent) => {
            handleTorrent(torrent);
        });

        async function handleTorrent(torrent) {
            try {
                torrentInstance = torrent;
                
                if (!torrent.name || !torrent.files || torrent.files.length === 0) {
                    console.log("⏳ Waiting for torrent metadata...");
                    await new Promise((resolve) => {
                        torrent.once('ready', resolve);
                    });
                }
                
                console.log(`✅ Torrent metadata received: ${torrent.name}`);
                
                // 1. CHOOSE WHICH FILES TO DOWNLOAD (Handles Single or Multiple selections)
                let selectedFiles = [];

                if (options.fileIndices && Array.isArray(options.fileIndices) && options.fileIndices.length > 0) {
                    // Map over all requested array indices and collect matching file profiles
                    selectedFiles = options.fileIndices.map(index => torrent.files[index]).filter(Boolean);
                    console.log(`📄 Selected ${selectedFiles.length} explicit files via indices.`);
                } else {
                    // Default fallback logic: Find and select ONLY the single largest file
                    const largestFile = torrent.files.reduce((largest, current) => 
                        current.length > largest.length ? current : largest
                    );
                    selectedFiles = [largestFile];
                    console.log(`📄 Auto-selected single largest file: ${largestFile.name}`);
                }

                // 2. CRITICAL FIX: Stop all files, then select ONLY the target group files explicitly
                // torrent.files.forEach(file => file.deselect()); 
                torrent.deselect(0, torrent.pieces.length - 1, 0); // Clear engine piece pipeline entirely
                
                selectedFiles.forEach(file => {
                    file.select(); // Re-engage streaming targets explicitly for our subset
                });

                // 3. AGGREGATE STATS Across our target selection array group
                const totalBytes = selectedFiles.reduce((sum, file) => sum + file.length, 0);
                
                // For naming values in database, pick first item's metadata attributes 
                const displayFileName = options.fileName || (selectedFiles.length === 1 ? selectedFiles[0].name : torrent.name);
                const fileExtension = selectedFiles.length === 1 ? (selectedFiles[0].name.split('.').pop() || 'unknown') : 'mixed';
                const baseLocationPath = path.join(downloadDir, displayFileName);

                await db.update(fileDownloads).set({
                    locationPath: baseLocationPath,
                    fileName: displayFileName,
                    fileType: fileExtension,
                    status: "downloading",
                    fileSize: totalBytes,
                    updatedAt: new Date(),
                }).where(eq(fileDownloads.id, id));

                // 4. ACCURATE COMBINED PROGRESS TRACKING LOOP
                progressInterval = setInterval(() => {
                    if (executionTriggered) return;

                    // Sum up exactly how many target bytes have landed for our SELECTED files only
                    const downloadedBytes = selectedFiles.reduce((sum, file) => sum + file.downloaded, 0);
                    let progressFraction = totalBytes > 0 ? downloadedBytes / totalBytes : 0;
                    let percent = (progressFraction * 100).toFixed(2);

                    const allSelectedFilesFinished = selectedFiles.every(file => file.progress === 1);

                    if (allSelectedFilesFinished) {
                        percent = 100.00;
                        progressFraction = 100;
                    }
                    
                    progressMap.set(id, {
                        downloadedBytes,
                        totalBytes,
                        percentFixed2: percent,
                        percent: Math.round(progressFraction * 100),
                    });

                    console.log(`📊 Batch Progress: ${percent}% | Speed: ${(torrent.downloadSpeed / 1024 / 1024).toFixed(2)} MB/s`);
                    
                    // Trigger completion when ALL bytes for our selected file group are present
                    if (allSelectedFilesFinished /*downloadedBytes >= totalBytes*/ && !executionTriggered) {
                        console.log("✅ All targeted file array structures reached 100%, completing...");
                        handleCompletion();
                    }
                }, 2000);

                const handleCompletion = async () => {
                    if (executionTriggered) return;
                    executionTriggered = true;
                    
                    console.log("✅ Selected torrent contents finished downloading.");
                    
                    // Rename routine: Only attempt rename logic safely if tracking a SINGLE file sequence
                    if (selectedFiles.length === 1 && options.fileName && selectedFiles[0].name !== options.fileName) {
                        const originalPath = path.join(downloadDir, selectedFiles[0].path);
                        try {
                            if (fs.existsSync(originalPath)) {
                                fs.renameSync(originalPath, baseLocationPath);
                                console.log(`📝 Renamed file to: ${displayFileName}`);
                            }
                        } catch (err) {
                            console.warn(`⚠️ Could not rename file: ${err.message}`);
                        }
                    }
                    
                    await pipelineCleanup({
                        status: "completed",
                        finalProgress: {
                            downloadedBytes: totalBytes,
                            totalBytes,
                            percent: 100,
                            percentFixed2: 100.0,
                            done: true,
                        }
                    });
                    
                    resolve({ filePath: baseLocationPath, fileName: displayFileName });
                };

                // Error Management Catch hooks
                torrent.on('error', async (err) => {
                    if (executionTriggered) return;
                    executionTriggered = true;
                    console.error("❌ Torrent engine layer error reported:", err);
                    
                    await pipelineCleanup({
                        status: "failed",
                        errorMessage: err?.message ?? "Torrent download failed"
                    });
                    reject(err);
                });

            } catch (error) {
                if (executionTriggered) return;
                executionTriggered = true;
                console.error("❌ Process runtime error encounter:", error);
                
                await pipelineCleanup({
                    status: "failed",
                    errorMessage: error?.message ?? "Failed to process torrent"
                });
                reject(error);
            }
        }
    });
}