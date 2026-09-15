"""HTTP file-info probing (mirror of the Express backend's fileInfo controller).

Probes a URL with a HEAD request (falling back to a 0-byte range GET) and
returns the shape the frontend's AddDownloadModal expects:

    {fileName, fileSize, fileType, fileExtension}

Never downloads the full file — at most fetches 0 bytes.
"""

from __future__ import annotations

import re
from typing import Optional
from urllib.parse import unquote, urlparse

import requests

from streamlift_worker import logger

_REQUEST_TIMEOUT = 10

_EXT_FROM_MIME = {
    "video/mp4": "mp4", "video/x-matroska": "mkv", "video/webm": "webm",
    "video/avi": "avi", "video/quicktime": "mov", "video/x-msvideo": "avi",
    "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg",
    "audio/flac": "flac", "audio/wav": "wav",
    "application/zip": "zip", "application/x-rar-compressed": "rar",
    "application/x-7z-compressed": "7z", "application/pdf": "pdf",
    "application/octet-stream": "bin",
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
    "image/webp": "webp",
}

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; StreamLift/1.0)",
    "Accept": "*/*",
}


def _parse_content_disposition(header: str) -> Optional[str]:
    if not header:
        return None
    utf8 = re.search(r"filename\*=UTF-8''([^;]+)", header, re.IGNORECASE)
    if utf8:
        try:
            return unquote(utf8.group(1).strip())
        except Exception:
            return utf8.group(1).strip()
    quoted = re.search(r'filename="([^"]+)"', header, re.IGNORECASE)
    if quoted:
        return quoted.group(1).strip()
    bare = re.search(r"filename=([^;]+)", header, re.IGNORECASE)
    if bare:
        return bare.group(1).strip()
    return None


def _filename_from_url(raw_url: str) -> Optional[str]:
    try:
        parsed = urlparse(raw_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return None
        last = parsed.path.rstrip("/").rsplit("/", 1)[-1]
        return unquote(last) if last else None
    except Exception:
        return None


def _ext_from_mime(mime: Optional[str]) -> Optional[str]:
    if not mime:
        return None
    base = mime.split(";")[0].strip().lower()
    mapped = _EXT_FROM_MIME.get(base)
    if mapped:
        return mapped
    return base.split("/")[1] if "/" in base else None


def fetch_http_file_info(url: str) -> Optional[dict]:
    """Probe *url* and return {fileName, fileSize, fileType, fileExtension}."""
    headers = dict(_HEADERS)
    response = None
    try:
        try:
            response = requests.head(url, headers=headers, timeout=_REQUEST_TIMEOUT, allow_redirects=True)
        except requests.Timeout:
            raise TimeoutError("Request timed out fetching file info")
        if not response.ok:
            response = requests.get(
                url,
                headers={**headers, "Range": "bytes=0-0"},
                timeout=_REQUEST_TIMEOUT,
                allow_redirects=True,
                stream=True,
            )
            if response.ok or response.status_code == 206:
                response.close()
            else:
                status = response.status_code
                response.close()
                logger.log("warning", f"Remote server returned {status} for {url}")
                return None
    except requests.Timeout:
        logger.log("warning", f"file-info timed out for {url}")
        raise
    except requests.RequestException as e:
        logger.log("warning", f"Could not reach {url}: {e}")
        raise
    except TimeoutError:
        logger.log("warning", f"file-info timed out for {url}")
        raise

    if response is None:
        return None

    content_type = response.headers.get("content-type")
    content_length = response.headers.get("content-length")
    if not content_length:
        content_range = response.headers.get("content-range")
        if content_range:
            m = re.search(r"/(\d+)$", content_range)
            content_length = m.group(1) if m else None

    file_type = content_type.split(";")[0].strip() if content_type else None
    file_extension = _ext_from_mime(file_type)
    file_size = int(content_length) if content_length else None

    raw_name = (
        _parse_content_disposition(response.headers.get("content-disposition"))
        or _filename_from_url(url)
    )
    file_name = raw_name or (f"download.{file_extension}" if file_extension else "download")

    logger.log("info", f"file-info: {file_name} ({file_size or 0} bytes)")
    return {
        "fileName": file_name,
        "fileSize": file_size,
        "fileType": file_type,
        "fileExtension": file_extension,
    }