/**
 * GET /api/file-info?url=<encoded-url>
 *
 * Does a HEAD (falling back to a range-GET) against the target URL and
 * returns the file metadata the browser needs to pre-fill the modal:
 *   { fileName, fileSize, fileType, fileExtension }
 *
 * Never downloads the full file — at most fetches 0 bytes.
 */

/** Extract filename from Content-Disposition header, or null */
function parseContentDisposition(header) {
    if (!header) return null;
    const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match) return decodeURIComponent(utf8Match[1].trim());
    const quotedMatch = header.match(/filename="([^"]+)"/i);
    if (quotedMatch) return quotedMatch[1].trim();
    const bareMatch = header.match(/filename=([^;]+)/i);
    if (bareMatch) return bareMatch[1].trim();
    return null;
}

/** Derive a filename from the URL path as last resort */
function filenameFromUrl(rawUrl) {
    try {
        const pathname = new URL(rawUrl).pathname;
        const last = pathname.split("/").filter(Boolean).pop();
        return last ? decodeURIComponent(last) : null;
    } catch {
        return null;
    }
}

/** Derive extension from mime type */
function extFromMime(mime) {
    if (!mime) return null;
    const map = {
        "video/mp4": "mp4", "video/x-matroska": "mkv", "video/webm": "webm",
        "video/avi": "avi", "video/quicktime": "mov", "video/x-msvideo": "avi",
        "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg",
        "audio/flac": "flac", "audio/wav": "wav",
        "application/zip": "zip", "application/x-rar-compressed": "rar",
        "application/x-7z-compressed": "7z", "application/pdf": "pdf",
        "application/octet-stream": "bin",
        "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
        "image/webp": "webp",
    };
    const base = mime.split(";")[0].trim().toLowerCase();
    return map[base] ?? base.split("/")[1] ?? null;
}

export async function getFileInfo(req, res) {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: "url query param is required" });
    }

    // Basic URL validation
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
            return res.status(400).json({ error: "Only http/https URLs are supported" });
        }
    } catch {
        return res.status(400).json({ error: "Invalid URL" });
    }

    const HEADERS = {
        "User-Agent": "Mozilla/5.0 (compatible; StreamLift/1.0)",
        "Accept": "*/*",
    };

    let response;
    try {
        // Try HEAD first (no body, fast)
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
            response = await fetch(url, {
                method: "HEAD",
                headers: HEADERS,
                signal: controller.signal,
                redirect: "follow",
            });
        } finally {
            clearTimeout(timeout);
        }

        // Some servers reject HEAD — fall back to GET with Range: bytes=0-0
        if (!response.ok) {
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), 10000);
            try {
                response = await fetch(url, {
                    method: "GET",
                    headers: { ...HEADERS, "Range": "bytes=0-0" },
                    signal: controller2.signal,
                    redirect: "follow",
                });
            } finally {
                clearTimeout(timeout2);
            }
            // Consume and discard the tiny body so the connection is released
            await response.body?.cancel();
        }
    } catch (err) {
        if (err.name === "AbortError") {
            return res.status(504).json({ error: "Request timed out fetching file info" });
        }
        return res.status(502).json({ error: "Could not reach the URL", details: err.message });
    }

    if (!response.ok && response.status !== 206) {
        return res.status(response.status).json({
            error: `Remote server returned ${response.status}`,
        });
    }

    const contentType = response.headers.get("content-type") ?? null;
    const contentLength = response.headers.get("content-length")
        ?? response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]
        ?? null;
    const contentDisposition = response.headers.get("content-disposition");

    const fileType = contentType ? contentType.split(";")[0].trim() : null;
    const fileExtension = extFromMime(fileType);
    const fileSize = contentLength ? Number(contentLength) : null;

    // Determine filename: content-disposition > URL path > fallback with ext
    const rawName = parseContentDisposition(contentDisposition) ?? filenameFromUrl(url);
    const fileName = rawName
        ?? (fileExtension ? `download.${fileExtension}` : "download");

    return res.json({ fileName, fileSize, fileType, fileExtension });
}
