import WebTorrent from "webtorrent";
import { progressMap } from "../../progressStore.js";
import { initMega } from "./megaStorage.js";
import { db, fileDownloads } from "../../../db/index.js";
import { eq } from "drizzle-orm";
import { Transform } from "stream";

/**
 * Find an existing folder by name inside a Mega directory node,
 * or create it if it doesn't exist. Returns the folder node.
 */
async function getOrCreateMegaFolder(parentNode, folderName) {
    const children = Object.values(parentNode.children ?? {});
    const existing = children.find(n => n.directory && n.name === folderName);
    if (existing) return existing;
    return parentNode.mkdir(folderName);
}

const client = new WebTorrent({
    dht: false,  // Disable Distributed Hash Table port-bindings
    utp: false,  // 🔒 DISABLE uTP (Forces clean, standard TCP stream connections only)
    // Don't set torrentPort - let WebTorrent handle it dynamically
    tracker: {
        getAnnounceOpts: () => ({ 
            numwant: 20,  // Request more peers initially to ensure we get some connections
            compact: 1    // Use compact peer format
        }),
        rtcConfig: false,      // Completely disable WebRTC tracking connections
        wrtc: false            // Disable WebRTC completely
    },
    maxConns: 6,  // Balanced: enough for metadata + download, but not too many
    downloadLimit: 1.5 * 1024 * 1024,  // Limit to 1.5 MB/s to prevent memory overflow
    uploadLimit: 100 * 1024,  // 100 KB/s upload to maintain good peer relationships
    // Server-friendly settings for restricted environments
    natUpnp: false,  // Disable UPnP (not available on cloud servers)
    natPmp: false,   // Disable NAT-PMP (not available on cloud servers)
    lsd: false       // Disable Local Service Discovery (not useful on cloud)
});

// ==========================================
// THE MAGIC BULLET: Zero-Memory / Zero-Disk Custom Store
// ==========================================
function FreeTierChunkStore(chunkLength, storeOpts) {
    this.chunkLength = chunkLength;
    this.chunks = [];
    this.maxChunks = 60; // Buffer for up to 60 chunks (~15MB at 256KB pieces)

    this.put = function (index, buf, cb) {
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

    this.close = function (cb) { 
        this.chunks = []; 
        if (cb) cb(null); 
    };
    
    this.destroy = function (cb) { 
        this.chunks = []; 
        if (cb) cb(null); 
    };

    // Custom method to wipe old data pieces instantly during execution loop transitions
    this.evict = function (index) {
        if (this.chunks[index]) {
            this.chunks[index] = null; // Free up V8 Garbage Collector target pointer instantly
            delete this.chunks[index];
        }
    };
}

export async function streamTorrentToMega(id, magnetLink, options = { fileName: null, fileIndices: null, guestId: null }) {
    const mega = await initMega();
    
    if (mega.ready && typeof mega.ready.then === 'function') {
        await mega.ready;
    }

    // Resolve the upload target node — guest folder when guestId is present, root otherwise
    const uploadTarget = options.guestId
        ? await getOrCreateMegaFolder(mega.root, options.guestId)
        : mega.root;

    return new Promise((resolve, reject) => {
        console.log(`🧲 Starting cloud-stream torrent download for ID: ${id}`);
        console.log(`🔍 Magnet link: ${magnetLink.substring(0, 100)}...`);
        console.log(`⚙️ WebTorrent config: maxConns=${client.maxConns}, downloadLimit=${client.downloadLimit ? (client.downloadLimit / 1024 / 1024).toFixed(1) : 'unlimited'}MB/s`);
        
        let progressInterval = null;
        let torrentInstance = null;
        let isFinalized = false;
        let customStoreInstance = null;
        
        // Store timeout IDs so we can clear them
        let metadataTimeout = null;
        let progressTimeout30 = null;
        let progressTimeout60 = null;
        let progressTimeout90 = null;

        // References to hold active file streams for safe error-cleanup access
        let currentTorrentStream = null;
        let currentTrackingStream = null;
        let currentFileStream = null;

        // Add timeout for metadata fetching (critical for server environments)
        metadataTimeout = setTimeout(() => {
            if (!torrentInstance || !torrentInstance.ready) {
                const timeoutError = new Error('Torrent metadata fetch timeout after 120 seconds. This may indicate network restrictions, unavailable peers, or dead torrent.');
                console.error('❌ Metadata timeout:', timeoutError.message);
                console.error('💡 Troubleshooting: Check if magnet link is valid and has active seeders');
                
                // Cleanup
                if (torrentInstance) {
                    try {
                        torrentInstance.destroy();
                    } catch (e) {
                        console.error('Error destroying torrent on timeout:', e);
                    }
                }
                
                reject(timeoutError);
            }
        }, 120000); // Increased to 120 seconds for better chance of success

        // Stream directly without downloading to disk - prevents /tmp storage overflow
        console.log(`📡 Adding torrent to WebTorrent client...`);
        
        client.add(magnetLink, {
            store: function (chunkLength, storeOpts) {
                customStoreInstance = new FreeTierChunkStore(chunkLength, storeOpts);
                return customStoreInstance;
            },
            // Add announce list with reliable public trackers
            announce: [
                'udp://tracker.opentrackr.org:1337/announce',
                'udp://open.stealth.si:80/announce',
                'udp://tracker.torrent.eu.org:451/announce',
                'udp://tracker.moeking.me:6969/announce',
                'https://tracker.nanoha.org:443/announce',
                'https://tracker.lilithraws.org:443/announce',
                'udp://exodus.desync.com:6969/announce',
                'udp://tracker.opentrackr.org:1337/announce',
                'udp://open.demonii.com:1337/announce',
                'udp://tracker.openbittorrent.com:6969/announce'
            ]
        }, (torrent) => {
            console.log(`✅ Torrent added to client successfully`);
            clearTimeout(metadataTimeout);
            clearTimeout(progressTimeout30);
            clearTimeout(progressTimeout60);
            clearTimeout(progressTimeout90);
            handleTorrent(torrent);
        });

        // Add error handler for client-level errors
        client.on('error', (err) => {
            console.error('❌ WebTorrent client error:', err);
            clearTimeout(metadataTimeout);
            clearTimeout(progressTimeout30);
            clearTimeout(progressTimeout60);
            clearTimeout(progressTimeout90);
            if (!isFinalized) {
                reject(err);
            }
        });
        
        // Log when we start trying to connect to trackers
        progressTimeout30 = setTimeout(() => {
            if (!torrentInstance) {
                console.log(`⏳ Still waiting for metadata... (30s elapsed)`);
                console.log(`💡 This is normal for some torrents. Trying to connect to trackers...`);
            }
        }, 30000);
        
        progressTimeout60 = setTimeout(() => {
            if (!torrentInstance) {
                console.log(`⏳ Still waiting for metadata... (60s elapsed)`);
                console.log(`⚠️ Taking longer than usual. Check if torrent has active seeders.`);
            }
        }, 60000);
        
        progressTimeout90 = setTimeout(() => {
            if (!torrentInstance) {
                console.log(`⏳ Still waiting for metadata... (90s elapsed)`);
                console.log(`⚠️ Last chance - will timeout in 30 seconds if no response.`);
            }
        }, 90000);

        async function handleTorrent(torrent) {
            try {
                torrentInstance = torrent;
                
                console.log(`🔍 Torrent added to client. InfoHash: ${torrent.infoHash}`);
                console.log(`📊 Initial state - Ready: ${torrent.ready}, Files: ${torrent.files?.length || 0}, Peers: ${torrent.numPeers}`);
                
                if (!torrent.name || !torrent.files || torrent.files.length === 0) {
                    console.log("⏳ Waiting for torrent metadata...");
                    
                    // Add timeout for ready event
                    const readyPromise = new Promise((resolve) => {
                        torrent.once('ready', resolve);
                    });
                    
                    const timeoutPromise = new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('Torrent ready timeout after 45 seconds')), 45000);
                    });
                    
                    await Promise.race([readyPromise, timeoutPromise]);
                }
                
                console.log(`✅ Torrent metadata received: ${torrent.name}`);
                console.log(`📊 Torrent stats - Files: ${torrent.files.length}, Size: ${(torrent.length / 1024 / 1024).toFixed(2)} MB, Peers: ${torrent.numPeers}`);
                
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

                // Build the locationPath stored in DB — just the filename, the guest folder is on Mega's side only
                const locationPath = baseFileName;

                await db.update(fileDownloads).set({
                    locationPath: locationPath,
                    fileName: baseFileName,
                    fileType: fileExtension,
                    status: "downloading",
                    fileSize: totalBytes,
                    updatedAt: new Date(),
                }).where(eq(fileDownloads.id, id)).catch(err => {
                    console.error('⚠️ Database update error (non-fatal):', err.message);
                });

                // ==========================================
                // FIX 2: Centralized Cleanup System
                // ==========================================
                const cleanupAndFinish = async (status, err = null, uploadedFiles = null) => {
                    if (isFinalized) return;
                    isFinalized = true;

                    // Clear all timers
                    if (progressInterval) {
                        clearInterval(progressInterval);
                        progressInterval = null;
                    }
                    
                    if (metadataTimeout) clearTimeout(metadataTimeout);
                    if (progressTimeout30) clearTimeout(progressTimeout30);
                    if (progressTimeout60) clearTimeout(progressTimeout60);
                    if (progressTimeout90) clearTimeout(progressTimeout90);

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
                        // Extract MEGA node handle from uploaded results
                        const handle = Array.isArray(uploadedFiles)
                            ? uploadedFiles[0]?.nodeId ?? null
                            : uploadedFiles?.nodeId ?? null;

                        await db.update(fileDownloads).set({
                            status: "completed",
                            cloudFileHandle: handle,
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
                    const memUsage = process.memoryUsage();
                    const memUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
                    
                    console.log(`📊 Progress: ${displayPercent}% | ` +
                               `Speed: ${(torrent.downloadSpeed / 1024 / 1024).toFixed(2)} MB/s | ` +
                               `Peers: ${torrent.numPeers} | ` +
                               `Downloaded: ${(downloadedBytes / 1024 / 1024).toFixed(2)} MB / ${(totalBytes / 1024 / 1024).toFixed(2)} MB | ` +
                               `Memory: ${memUsedMB} MB`);
                    
                    // Warning if no peers after some time
                    if (torrent.numPeers === 0 && downloadedBytes === 0) {
                        console.warn('⚠️ No peers connected yet. This may indicate network restrictions or unavailable torrent.');
                    }
                    
                    // CRITICAL: Memory safety check for Render's 512MB limit
                    if (memUsage.heapUsed > 400 * 1024 * 1024) { // 400MB threshold
                        console.warn(`⚠️ HIGH MEMORY USAGE: ${memUsedMB} MB - Forcing garbage collection`);
                        if (global.gc) {
                            global.gc();
                        }
                    }
                    
                    // Emergency stop if memory exceeds 450MB
                    if (memUsage.heapUsed > 450 * 1024 * 1024) {
                        console.error(`❌ CRITICAL MEMORY: ${memUsedMB} MB - Aborting to prevent crash`);
                        cleanupAndFinish("failed", new Error(`Memory limit exceeded: ${memUsedMB} MB`));
                    }
                }, 5000);
                
                // Monitor peer connections
                torrent.on('wire', (wire, addr) => {
                    console.log(`🔗 Connected to peer: ${addr || 'unknown'}`);
                });
                
                torrent.on('noPeers', (announceType) => {
                    console.warn(`⚠️ No peers found via ${announceType}. Trying other trackers...`);
                });

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
                    console.log(`📦 File size: ${(currentFile.length / 1024 / 1024).toFixed(2)} MB`);

                    await new Promise((resolveFile, rejectFile) => {
                        let fileDownloadedBytes = 0;
                        
                        let lastConsumedPiece = -1;
                        const pieceLength = torrent.pieceLength || 262144; // default 256KB

                        // Evict only pieces that are behind what the stream has actually consumed.
                        // We calculate the last piece the stream has fully passed based on bytes read.
                        currentTrackingStream = new Transform({
                            highWaterMark: 16 * 1024,
                            transform(chunk, encoding, callback) {
                                downloadedBytes += chunk.length;
                                fileDownloadedBytes += chunk.length;

                                const percent = ((downloadedBytes / totalBytes) * 100).toFixed(2);
                                progressMap.set(id, {
                                    downloadedBytes,
                                    totalBytes,
                                    percentFixed2: percent,
                                    percent: Math.round((downloadedBytes / totalBytes) * 100),
                                });

                                // Track which piece the stream has consumed up to
                                const consumedPiece = Math.floor(
                                    (currentFile.offset + fileDownloadedBytes) / pieceLength
                                );
                                // Evict pieces well behind the read head (keep a 30-piece buffer)
                                if (customStoreInstance && consumedPiece > lastConsumedPiece + 30) {
                                    for (let p = lastConsumedPiece + 1; p < consumedPiece - 30; p++) {
                                        customStoreInstance.evict(p);
                                    }
                                    lastConsumedPiece = consumedPiece - 30;
                                }

                                this.push(chunk);
                                callback();
                            },
                            flush(callback) {
                                if (fileDownloadedBytes < currentFile.length) {
                                    console.error(`⚠️ Stream ended early: got ${fileDownloadedBytes} / ${currentFile.length} bytes`);
                                    callback(new Error(`Incomplete download: ${fileDownloadedBytes} / ${currentFile.length} bytes`));
                                } else {
                                    console.log(`✅ Stream complete: ${fileDownloadedBytes} bytes`);
                                    callback();
                                }
                            }
                        });

                        currentFileStream = uploadTarget.upload({
                            name: targetUploadName,
                            size: currentFile.length,
                            allowUploadBuffering: true
                        });

                        currentTorrentStream = currentFile.createReadStream({
                            autoClose: false
                        });
                        
                        // Assemble the pipeline channels
                        currentTorrentStream.pipe(currentTrackingStream).pipe(currentFileStream);

                        currentFileStream.on("complete", (uploadedFile) => {
                            console.log(`✅ Finished uploading target file: ${currentFile.name}`);
                            console.log("MEGA node ID:", uploadedFile?.nodeId);
                            uploadedResults.push(uploadedFile);
                            
                            // Close down local stream hooks immediately to clean the execution track
                            currentTorrentStream.destroy();
                            currentTrackingStream.destroy();
                            resolveFile();
                        });

                        const handleStreamError = (err) => {
                            console.error(`❌ Pipeline crash encountered on "${currentFile.name}":`, err);
                            console.error(`📊 Download progress: ${downloadedBytes} / ${totalBytes} bytes`);
                            console.error(`📊 Current file expected: ${currentFile.length} bytes`);
                            console.error(`💡 This may indicate: chunk eviction too aggressive, stream interrupted, or network issue`);
                            rejectFile(err);
                        };

                        currentFileStream.on("error", handleStreamError);
                        currentTorrentStream.on("error", handleStreamError);
                        currentTrackingStream.on("error", handleStreamError);
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