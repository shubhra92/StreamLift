import WebTorrent from "webtorrent";
import { progressMap } from "./progressStore.js";
import { initMega } from "./megaStorage.js";
import { db, fileDownloads } from "../db/index.js";
import { eq } from "drizzle-orm";
import { Transform } from "stream";

const client = new WebTorrent({
    dht: false,  // Disable Distributed Hash Table port-bindings
    utp: false,  // 🔒 DISABLE uTP (Forces clean, standard TCP stream connections only)
    torrentPort: 15000,  // ⚡ Move to 15000 so it NEVER collides with your Express App on 10000
    tracker: {
        getAnnounceOpts: () => ({ numwant: 3 }), // Keep peer lists tiny to restrict incoming connection requests
        rtcConfig: false      // Completely disable WebRTC tracking connections 
    },
    maxConns: 5,  // Limit concurrent connections to reduce memory usage
    downloadLimit: -1,  // No download speed limit
    // uploadLimit: 0  // Disable uploading to save bandwidth and memory
});

// ==========================================
// THE MAGIC BULLET: Zero-Memory / Zero-Disk Custom Store
// ==========================================
function FreeTierChunkStore(chunkLength, storeOpts) {
    this.chunkLength = chunkLength;
    this.chunks = [];

    this.put = function (index, buf, cb) {
        // Keep chunks localized strictly within active streaming allocations
        this.chunks[index] = buf;
        if (cb) cb(null);
    };

    this.get = function (index, opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = null; }
        const buf = this.chunks[index];
        if (!buf) return cb(new Error('Chunk not found'));

        const start = (opts && opts.offset) || 0;
        const end = (opts && opts.length) ? start + opts.length : buf.length;
        cb(null, buf.slice(start, end));
    };

    this.close = function (cb) { this.chunks = []; if (cb) cb(null); };
    this.destroy = function (cb) { this.chunks = []; if (cb) cb(null); };

    // Custom method to wipe old data pieces instantly during execution loop transitions
    this.evict = function (index) {
        if (this.chunks[index]) {
            this.chunks[index] = null; // Free up V8 Garbage Collector target pointer instantly
        }
    };
}

export async function streamTorrentToMega(id, magnetLink, options = { fileName: null, fileIndices: null }) {
    const mega = await initMega();
    
    if (mega.ready && typeof mega.ready.then === 'function') {
        await mega.ready;
    }

    return new Promise((resolve, reject) => {
        console.log(`🧲 Starting cloud-stream torrent download for ID: ${id}`);
        
        let progressInterval = null;
        let torrentInstance = null;
        let isFinalized = false;
        let customStoreInstance = null;

        // References to hold active file streams for safe error-cleanup access
        let currentTorrentStream = null;
        let currentTrackingStream = null;
        let currentFileStream = null;

        // Stream directly without downloading to disk - prevents /tmp storage overflow
        client.add(magnetLink, {
            store: function (chunkLength, storeOpts) {
                customStoreInstance = new FreeTierChunkStore(chunkLength, storeOpts);
                return customStoreInstance;
            }
        }, (torrent) => {
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
                
                // ==========================================
                // FIX 1: Apply WebTorrent Selection Bypass
                // ==========================================
                torrent.deselect(0, torrent.pieces.length - 1, false); 
                torrent.files.forEach(file => {
                    file.deselect();
                });
                
                let selectedFiles = [];

                if (options.fileIndices && Array.isArray(options.fileIndices) && options.fileIndices.length > 0) {
                    selectedFiles = options.fileIndices.map(index => torrent.files[index]).filter(Boolean);
                    selectedFiles.forEach(file => {
                        file.select();
                    });
                    console.log(`📄 Selected ${selectedFiles.length} files via explicit indices.`);
                } else {
                    const largestFile = torrent.files.reduce((largest, current) =>
                        current.length > largest.length ? current : largest
                    );
                    largestFile.select();
                    selectedFiles = [largestFile];
                    console.log(`📄 Auto-selected single largest file: ${largestFile.name}`);
                }

                // Global size metrics across all selected data chunks
                const totalBytes = selectedFiles.reduce((sum, file) => sum + file.length, 0);
                const baseFileName = options.fileName || (selectedFiles.length === 1 ? selectedFiles[0].name : torrent.name);
                const fileExtension = selectedFiles.length === 1 ? (selectedFiles[0].name.split('.').pop() || 'unknown') : 'mixed';
                let downloadedBytes = 0;

                await db.update(fileDownloads).set({
                    locationPath: baseFileName,
                    fileName: baseFileName,
                    fileType: fileExtension,
                    status: "downloading",
                    fileSize: totalBytes,
                    updatedAt: new Date(),
                }).where(eq(fileDownloads.id, id));

                // ==========================================
                // FIX 2: Centralized Cleanup System
                // ==========================================
                const cleanupAndFinish = async (status, err = null, uploadedFiles = null) => {
                    if (isFinalized) return;
                    isFinalized = true;

                    if (progressInterval) {
                        clearInterval(progressInterval);
                        progressInterval = null;
                    }

                    // Destroy active stream pipelines to unlock memory allocations
                    if (currentTorrentStream) currentTorrentStream.destroy();
                    if (currentTrackingStream) currentTrackingStream.destroy();
                    if (currentFileStream) currentFileStream.destroy();

                    if (torrentInstance) {
                        try {
                            torrentInstance.destroy({ destroyStore: true });
                            console.log("🔌 WebTorrent instance closed down safely.");
                        } catch (e) {
                            console.error("Error destroying torrent:", e);
                        }
                        torrentInstance = null;
                    }

                    if (customStoreInstance) {
                        customStoreInstance.destroy();
                        customStoreInstance = null;
                    }

                    if (status === "completed") {
                        await db.update(fileDownloads).set({
                            status: "completed",
                            updatedAt: new Date(),
                        }).where(eq(fileDownloads.id, id));
                        
                        progressMap.set(id, {
                            downloadedBytes: totalBytes,
                            totalBytes,
                            percent: 100,
                            percentFixed2: "100.00",
                            done: true,
                        });
                        
                        resolve(uploadedFiles);
                    } else {
                        await db.update(fileDownloads).set({
                            status: "failed",
                            errorMessage: err?.message ?? "Stream upload sequence failed",
                            updatedAt: new Date(),
                        }).where(eq(fileDownloads.id, id));
                        
                        progressMap.set(id, { done: true });
                        reject(err);
                    }
                };

                // Periodic logger monitoring continuous global upload scale progress
                progressInterval = setInterval(() => {
                    if (isFinalized) return;
                    
                    const displayPercent = ((downloadedBytes / totalBytes) * 100).toFixed(2);
                    console.log(`📊 Batch Stream Progress: ${displayPercent}% | ` +
                               `Engine Speed: ${(torrent.downloadSpeed / 1024 / 1024).toFixed(2)} MB/s | ` +
                               `Peers: ${torrent.numPeers}`);
                }, 5000);

                // ==========================================
                // FIX 3: Sequential Upload Processing Loop
                // ==========================================
                const uploadedResults = [];

                for (let i = 0; i < selectedFiles.length; i++) {
                    if (isFinalized) break;

                    const currentFile = selectedFiles[i];
                    // If exactly 1 file is selected, prioritize options.fileName. Otherwise, maintain pristine filenames inside cloud destination.
                    const targetUploadName = (selectedFiles.length === 1 && options.fileName) ? options.fileName : currentFile.name;

                    console.log(`🚀 [File ${i + 1}/${selectedFiles.length}] Streaming "${currentFile.name}" directly to MEGA...`);

                    await new Promise((resolveFile, rejectFile) => {
                        currentTrackingStream = new Transform({
                            highWaterMark: 32 * 1024, // 32KB backpressure gate
                            transform(chunk, encoding, callback) {
                                downloadedBytes += chunk.length;
                                
                                const percent = ((downloadedBytes / totalBytes) * 100).toFixed(2);
                                progressMap.set(id, {
                                    downloadedBytes,
                                    totalBytes,
                                    percentFixed2: percent,
                                    percent: Math.round((downloadedBytes / totalBytes) * 100),
                                });
                                
                                this.push(chunk);
                                callback();
                            }
                        });

                        currentFileStream = mega.upload({
                            name: targetUploadName,
                            size: currentFile.length
                        });

                        currentTorrentStream = currentFile.createReadStream();

                        // Evict verified pieces from memory immediately after they successfully transition downstream
                        torrent.on('piece', (pieceIndex) => {
                            if (customStoreInstance && !isFinalized) {
                                customStoreInstance.evict(pieceIndex);
                            }
                        });
                        
                        // Assemble the pipeline channels
                        currentTorrentStream.pipe(currentTrackingStream).pipe(currentFileStream);

                        currentFileStream.on("complete", (uploadedFile) => {
                            console.log(`✅ Finished uploading target file: ${currentFile.name}`);
                            uploadedResults.push(uploadedFile);
                            
                            // Close down local stream hooks immediately to clean the execution track
                            currentTorrentStream.destroy();
                            currentTrackingStream.destroy();
                            resolveFile();
                        });

                        const handleStreamError = (err) => {
                            console.error(`❌ Pipeline crash encountered on "${currentFile.name}":`, err);
                            rejectFile(err);
                        };

                        currentFileStream.on("error", handleStreamError);
                        currentTorrentStream.on("error", handleStreamError);
                    }).catch(err => {
                        // Forward loop promises errors straight to the master pipeline finalizer
                        cleanupAndFinish("failed", err);
                    });
                }

                // If the entire stack loop clears out seamlessly without triggering error hooks
                if (!isFinalized) {
                    console.log("🎉 All selected batch items safely pushed into cloud environments!");
                    cleanupAndFinish("completed", null, selectedFiles.length === 1 ? uploadedResults[0] : uploadedResults);
                }

            } catch (error) {
                console.error("❌ Error setting up torrent processing stream pipeline:", error);
                cleanupAndFinish("failed", error);
            }
        }
    });
}