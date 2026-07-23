import WebTorrent from "webtorrent";

// Safety net for webtorrent's internal null-ref bug (ut_metadata fires
// after torrent is destroyed → torrent.client is null → TypeError).
// This is a known webtorrent issue — swallow it so the server stays alive.
process.on("uncaughtException", (err) => {
    if (
        err instanceof TypeError &&
        err.message.includes("Cannot read properties of null") &&
        err.stack?.includes("webtorrent")
    ) {
        console.error("⚠️  Caught webtorrent internal null-ref (safe to ignore):", err.message);
        return;
    }
    throw err;
});

export async function getTorrentMetadata(req, res) {
    const { magnet_link } = req.body;

    if (!magnet_link) {
        return res.status(400).send({ status: false, message: "magnet_link is required" });
    }
    if (!magnet_link.startsWith("magnet:?")) {
        return res.status(400).send({ status: false, message: "Invalid magnet link format" });
    }

    console.log("🔍 Fetching torrent metadata...");

    // Use a fresh client per request — completely avoids duplicate-hash issues
    // since the client is destroyed after each fetch regardless of outcome.
    const client = new WebTorrent();
    client.on("error", (err) => {
        console.error("⚠️  WebTorrent client error:", err.message);
    });

    let timeoutId = null;

    const destroyClient = () => {
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        // Delay destruction slightly so in-flight ut_metadata callbacks
        // don't hit a null client reference and throw uncaught exceptions.
        setTimeout(() => {
            try { client.destroy(); } catch (_) {}
        }, 300);
    };

    try {
        const metadata = await new Promise((resolve, reject) => {
            timeoutId = setTimeout(() => reject(new Error("TIMEOUT")), 30000);

            const handle = client.add(
                magnet_link,
                { path: "/tmp", skipVerify: true },
                (torrent) => {
                    try {
                        // Shouldn't happen, but guard against empty file list
                        if (!torrent.files || torrent.files.length === 0) {
                            return reject(new Error("Torrent has no files in metadata"));
                        }

                        const files = torrent.files
                            .map((file, index) => ({
                                index,
                                name: file.name,
                                path: file.path,
                                size: file.length,
                                sizeFormatted: formatBytes(file.length),
                                type: getFileType(file.name),
                            }))
                            .sort((a, b) => b.size - a.size);

                        console.log(`✅ Metadata fetched: ${torrent.name} (${files.length} files)`);

                        resolve({
                            name: torrent.name,
                            infoHash: torrent.infoHash,
                            totalSize: torrent.length,
                            totalSizeFormatted: formatBytes(torrent.length),
                            files,
                            fileCount: files.length,
                        });
                    } catch (err) {
                        reject(err);
                    }
                }
            );

            handle.on("error", (err) => reject(err));
        });

        destroyClient();
        return res.status(200).send({ status: true, message: "Metadata fetched successfully", data: metadata });

    } catch (error) {
        destroyClient();

        if (error.message === "TIMEOUT") {
            console.log("⚠️  Metadata fetch timed out.");
            return res.status(408).send({
                status: false,
                message: "Timeout: Could not fetch metadata. Torrent might be dead or have no seeders.",
            });
        }

        console.error("Error in getTorrentMetadata:", error);
        return res.status(500).send({ status: false, message: "Failed to fetch metadata", details: error.message });
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function getFileType(filename) {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    if (["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v"].includes(ext)) return "video";
    if (["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"].includes(ext)) return "audio";
    if (["jpg", "jpeg", "png", "gif", "bmp", "svg", "webp"].includes(ext)) return "image";
    if (["pdf", "doc", "docx", "txt", "rtf", "odt", "epub"].includes(ext)) return "document";
    if (["zip", "rar", "7z", "tar", "gz", "bz2"].includes(ext)) return "archive";
    return "other";
}
