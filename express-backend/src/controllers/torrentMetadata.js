import WebTorrent from "webtorrent";

// Create a client for metadata fetching only
const metadataClient = new WebTorrent();

export async function getTorrentMetadata(req, res) {
    let isSettled = false; // Guard to prevent double responses
    let timeoutId = null;
    let activeTorrent = null;

    // Clean up function to prevent memory leaks and zombie torrent instances
    const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (activeTorrent) {
            const torrentToDestroy = activeTorrent;
            activeTorrent = null;
            
            process.nextTick(() => {
                try {
                    if (torrentToDestroy && typeof torrentToDestroy.destroy === 'function') {
                        torrentToDestroy.destroy({ destroyStore: true });
                    }
                } catch (e) {
                    console.error("Error destroying torrent during deferred cleanup:", e);
                }
            })
        }
    };


    try {
        const { magnet_link } = req.body;

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

        console.log("🔍 Fetching torrent metadata...");

        const metadata = await new Promise((resolve, reject) => {

            timeoutId = setTimeout(() => {
                reject(new Error("TIMEOUT"));
            }, 30000); // 30 seconds


            // Add torrent but don't download files yet
            metadataClient.add(magnet_link, { 
                path: '/tmp',
                // Don't start downloading automatically
                skipVerify: true 
            }, (torrent) => {
                try {
                    activeTorrent = torrent;

                    if (isSettled) {
                        cleanup();
                        return;
                    }

                    // Extract file information
                    const files = torrent.files.map((file, index) => ({
                        index,
                        name: file.name,
                        path: file.path,
                        size: file.length,
                        sizeFormatted: formatBytes(file.length),
                        type: getFileType(file.name),
                    }));

                    // Sort by size (largest first)
                    files.sort((a, b) => b.size - a.size);

                    const metadata = {
                        name: torrent.name,
                        infoHash: torrent.infoHash,
                        totalSize: torrent.length,
                        totalSizeFormatted: formatBytes(torrent.length),
                        files: files,
                        fileCount: files.length,
                    };

                    console.log(`✅ Metadata fetched: ${torrent.name} (${files.length} files)`);
                    return resolve(metadata)

                } catch (error) {
                    reject(error);
                }
            });
        })

        isSettled = true;
        cleanup();

        return res.status(200).send({
            status: true,
            message: "Metadata fetched successfully",
            data: metadata
        })

    } catch (error) {
        isSettled = true;
        cleanup();

        if(error.message === "TIMEOUT"){
            console.log("⚠️ Metadata fetch timed out.");
            return res.status(408).send({
                status: false,
                message: "Timeout: Could not fetch metadata. Torrent might be dead or have no seeders."
            });
        }

        console.error("Error in getTorrentMetadata:", error);
        return res.status(500).send({
            status: false,
            details: error.message
        });
    }
}

// Helper function to format bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper function to get file type
function getFileType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    
    const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v'];
    const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'];
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'];
    const documentExts = ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt'];
    const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];
    
    if (videoExts.includes(ext)) return 'video';
    if (audioExts.includes(ext)) return 'audio';
    if (imageExts.includes(ext)) return 'image';
    if (documentExts.includes(ext)) return 'document';
    if (archiveExts.includes(ext)) return 'archive';
    
    return 'other';
}
