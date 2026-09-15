"""
FastAPI server — exposes the worker's HTTP + SSE API.

Endpoints:
  GET  /health                        — unauthenticated
  GET  /status                        — session token
  GET  /stream                        — session token, SSE
  POST /download                      — session token
  DELETE /download/{download_id}      — session token
  POST /downloads/files               — session token, batch local-file availability
  GET  /downloads/{id}/files/{index}  — session token, completed local file
  POST /downloads/{id}/files/{index}/browser-link — session token, create file-only browser ticket
  GET  /browser-download/{token}      — redirects HTTPS browser navigation to HTTP download
  POST /downloads/{id}/share          — session token, mint MEGA share link
  POST /file-info                     — session token, HTTP URL metadata probe
  POST /torrent-metadata              — session token, magnet → aria2c metadata
  POST /internal/rotate-token         — auth token (internal use only)
"""

import asyncio
import json
import os
import re
import secrets
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlencode

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

from streamlift_worker import logger
from streamlift_worker.local_files import get_completed_files, resolve_completed_file
from streamlift_worker.metrics import get_system_metrics
from streamlift_worker.config import START_TIME

# ── Module-level state shared with worker.py ──────────────────────────────────

# Set by worker.py on startup
_config                          = None
_current_task: dict              = {}
_session_token: Optional[str]   = None   # short-lived, rotatable
_public_http_url: Optional[str] = None   # current Pinggy HTTP URL for native downloads
_cancel_flags: dict[str, bool]  = {}     # download_id → True means cancel requested
# Browser-download tickets are intentionally in-memory. They survive only for
# this worker process and authorize exactly one completed worker-local file.
_browser_download_tokens: dict[str, tuple[str, int]] = {}
_browser_token_by_file: dict[tuple[str, int], str] = {}
_browser_download_tokens_lock = threading.Lock()


def init_server(
    config,
    current_task: dict,
    initial_session_token: str,
    public_http_url: Optional[str] = None,
) -> None:
    """Called once by worker.py before uvicorn starts."""
    global _config, _current_task, _session_token, _public_http_url
    _config         = config
    _current_task   = current_task
    _session_token  = initial_session_token
    _public_http_url = public_http_url


def update_session_token(session_token: str) -> None:
    """Apply the token returned when the worker re-registers after a tunnel renewal."""
    global _session_token
    _session_token = session_token


def update_public_http_url(public_http_url: Optional[str]) -> None:
    """Apply the HTTP URL supplied by Pinggy after a tunnel renewal."""
    global _public_http_url
    _public_http_url = public_http_url


def get_cancel_flag(download_id: str) -> bool:
    return _cancel_flags.get(download_id, False)


def clear_cancel_flag(download_id: str) -> None:
    _cancel_flags.pop(download_id, None)


# ── Auth helpers ──────────────────────────────────────────────────────────────

def _require_session_token(x_session_token: Optional[str]) -> None:
    if not _session_token:
        raise HTTPException(status_code=503, detail="Worker not initialised yet")
    if x_session_token != _session_token:
        raise HTTPException(status_code=401, detail="Invalid or expired session token")


def _require_auth_token(x_auth_token: Optional[str]) -> None:
    if not _config:
        raise HTTPException(status_code=503, detail="Worker not initialised yet")
    if x_auth_token != _config.auth_token:
        raise HTTPException(status_code=401, detail="Invalid auth token")


def _get_or_create_browser_download_token(download_id: str, file_index: int) -> str:
    """Return a stable in-memory, file-scoped ticket for this worker session."""
    key = (download_id, file_index)
    with _browser_download_tokens_lock:
        existing = _browser_token_by_file.get(key)
        if existing:
            return existing
        token = secrets.token_urlsafe(32)
        _browser_download_tokens[token] = key
        _browser_token_by_file[key] = token
        return token


def _require_browser_download_token(token: Optional[str], download_id: str, file_index: int) -> None:
    if not token:
        raise HTTPException(status_code=401, detail="Missing browser download token")
    with _browser_download_tokens_lock:
        target = _browser_download_tokens.get(token)
    if target != (download_id, file_index):
        raise HTTPException(status_code=401, detail="Invalid browser download token")


def _remove_browser_download_token(token: Optional[str]) -> None:
    if not token:
        return
    with _browser_download_tokens_lock:
        target = _browser_download_tokens.pop(token, None)
        if target:
            _browser_token_by_file.pop(target, None)


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="StreamLift Worker", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    # Content-Range is NOT CORS-safelisted — without this, browsers hide it
    # from fetch() and the client cannot validate byte-range responses.
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length", "Content-Disposition"],
)


# ── GET /health ───────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    from streamlift_worker import __version__
    return {
        "status":            "ok",
        "version":           __version__,
        "downloadLocation":  _config.download_location if _config else "unknown",
    }


# ── GET /status ───────────────────────────────────────────────────────────────

@app.get("/status")
async def status(x_session_token: Optional[str] = Header(default=None)):
    _require_session_token(x_session_token)
    metrics = get_system_metrics()
    return {
        "online":      True,
        "currentTask": _current_task or None,
        "metrics":     metrics,
    }


# ── GET /stream  (SSE) ────────────────────────────────────────────────────────

@app.get("/stream")
async def stream(
    request: Request,
    x_session_token: Optional[str] = Header(default=None),
    token: Optional[str] = None,   # query param fallback for EventSource (no custom headers)
):
    # Accept token from header OR query param (EventSource can't set headers)
    provided_token = x_session_token or token
    if not _session_token:
        raise HTTPException(status_code=503, detail="Worker not initialised yet")
    if provided_token != _session_token:
        raise HTTPException(status_code=401, detail="Invalid or expired session token")
    async def _event_generator():
        last_ping = time.time()
        try:
            while True:
                from streamlift_worker.logger import peek_recent
                metrics = get_system_metrics()
                payload = {
                    "online":      True,
                    "currentTask": _current_task or None,
                    "metrics":     metrics,
                    "logs":        peek_recent(20),
                    "timestamp":   datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "uptimeSeconds": int(time.time() - START_TIME),
                }
                yield f"data: {json.dumps(payload)}\n\n"

                # Keep-alive comment every 15s to prevent proxy timeouts
                now = time.time()
                if now - last_ping >= 15:
                    yield ": ping\n\n"
                    last_ping = now

                await asyncio.sleep(2)

                # Check disconnect AFTER yielding, not before — some proxies
                # report is_disconnected() = True prematurely on the first check
                if await request.is_disconnected():
                    break
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache, no-transform",
            "X-Accel-Buffering": "no",      # disable nginx/Pinggy proxy buffering
            "Connection":        "keep-alive",
            "Transfer-Encoding": "chunked",  # force chunked — prevents Content-Length
        },
    )


# ── POST /download ────────────────────────────────────────────────────────────

class DownloadRequest(BaseModel):
    downloadId:   str
    sourceUrl:    str
    fileName:     str        = "download"
    downloadType: str        = "http"   # "http" | "torrent"
    fileIndices:  list[int] | None = None


class ShareLinkRequest(BaseModel):
    fileName: str = ""


class FileInfoRequest(BaseModel):
    url: str


class TorrentMetadataRequest(BaseModel):
    magnetLink: str


class FileAvailabilityRequest(BaseModel):
    downloadIds: list[str]


@app.post("/downloads/files")
async def list_completed_files(
    body: FileAvailabilityRequest,
    x_session_token: Optional[str] = Header(default=None),
):
    _require_session_token(x_session_token)
    # Bound the request so an authenticated browser cannot make the worker scan
    # an unbounded list through the public tunnel.
    ids = body.downloadIds[:100]
    return {
        "filesByDownload": {
            download_id: get_completed_files(download_id)
            for download_id in ids
        },
    }


# ── GET /downloads/{download_id}/files/{file_index} ──────────────────────────

# Byte range via query param (?range=bytes=start-end). Query strings always
# survive proxies, unlike Range headers, which some tunnels strip — this is
# what the frontend uses for parallel multi-connection downloads.
_RANGE_RE = re.compile(r"^bytes=(\d+)-(\d+)?$")
_RANGE_CHUNK = 1024 * 1024


def _stream_file_range(path: str, start: int, end: int):
    """Yield the file bytes in [start, end] inclusive, in 1 MB chunks."""
    remaining = end - start + 1
    with open(path, "rb") as handle:
        handle.seek(start)
        while remaining > 0:
            chunk = handle.read(min(_RANGE_CHUNK, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def _range_response(path: str, range_spec: str):
    """Build a 206 partial-content response for 'bytes=start-end'."""
    match = _RANGE_RE.match(range_spec)
    if not match:
        raise HTTPException(status_code=400, detail="Invalid range — expected bytes=start-end")
    size = os.path.getsize(path)
    start = int(match.group(1))
    end = int(match.group(2)) if match.group(2) is not None else size - 1
    if start >= size:
        raise HTTPException(status_code=416, detail=f"Requested range not satisfiable (size={size})")
    end = min(end, size - 1)
    return StreamingResponse(
        _stream_file_range(path, start, end),
        status_code=206,
        media_type="application/octet-stream",
        headers={
            "Content-Range":   f"bytes {start}-{end}/{size}",
            "Content-Length":  str(end - start + 1),
            "Accept-Ranges":   "bytes",
            "Cache-Control":   "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/downloads/{download_id}/files/{file_index}")
async def download_completed_file(
    download_id: str,
    file_index: int,
    x_session_token: Optional[str] = Header(default=None),
    download_token: Optional[str] = None,
    range: Optional[str] = None,
):
    if x_session_token:
        _require_session_token(x_session_token)
    else:
        _require_browser_download_token(download_token, download_id, file_index)
    resolved = resolve_completed_file(download_id, file_index)
    if not resolved:
        _remove_browser_download_token(download_token)
        raise HTTPException(status_code=404, detail="Completed file is no longer available on this worker")
    path, file_name = resolved
    if range:
        return _range_response(path, range)
    return FileResponse(path, filename=file_name, media_type="application/octet-stream")


@app.post("/downloads/{download_id}/files/{file_index}/browser-link")
async def create_browser_download_link(
    download_id: str,
    file_index: int,
    x_session_token: Optional[str] = Header(default=None),
):
    """Create a worker-local ticket for a native browser download navigation."""
    _require_session_token(x_session_token)
    if not resolve_completed_file(download_id, file_index):
        raise HTTPException(status_code=404, detail="Completed file is no longer available on this worker")
    token = _get_or_create_browser_download_token(download_id, file_index)
    return {"startPath": f"/browser-download/{token}"}


@app.get("/browser-download/{download_token}")
async def begin_browser_download(download_token: str, request: Request):
    """Validate a file-only ticket, then transition the new tab to HTTP download."""
    with _browser_download_tokens_lock:
        target = _browser_download_tokens.get(download_token)
    if not target:
        raise HTTPException(status_code=401, detail="Invalid browser download token")

    download_id, file_index = target
    if not resolve_completed_file(download_id, file_index):
        _remove_browser_download_token(download_token)
        raise HTTPException(status_code=404, detail="Completed file is no longer available on this worker")

    # Use the exact HTTP URL emitted by Pinggy at tunnel startup. Deriving it
    # from request.base_url is unreliable behind a reverse proxy and can leave
    # the browser on HTTPS instead of the intended native-download URL.
    if not _public_http_url:
        raise HTTPException(status_code=503, detail="Worker HTTP download URL is not ready")
    http_base_url = _public_http_url.rstrip("/") + "/"
    file_path = f"downloads/{download_id}/files/{file_index}"
    query = urlencode({"download_token": download_token})
    return RedirectResponse(url=f"{http_base_url}{file_path}?{query}", status_code=307)


@app.post("/download")
async def trigger_download(
    body: DownloadRequest,
    x_session_token: Optional[str] = Header(default=None),
):
    _require_session_token(x_session_token)

    if not _config:
        raise HTTPException(status_code=503, detail="Worker not initialised yet")

    # Only one task may run at a time. A request for a DIFFERENT download is a
    # hard 409 — the worker is single-slot. A repeat request for the SAME
    # download is treated as an idempotent retry: accept it but never spawn a
    # second thread (the downloader also dedupes in-flight ids). This is what
    # stops a raced double-dispatch from producing two concurrent streams.
    if _current_task and _current_task.get("downloadId") == body.downloadId:
        return {
            "success":       True,
            "downloadId":    body.downloadId,
            "alreadyRunning": True,
        }
    if _current_task and _current_task.get("downloadId") != body.downloadId:
        raise HTTPException(
            status_code=409,
            detail=f"Worker is busy with download {_current_task.get('downloadId')}",
        )

    # Convert to the dict format that downloader.py expects
    task = {
        "downloadId":   body.downloadId,
        "sourceUrl":    body.sourceUrl,
        "fileName":     body.fileName,
        "downloadType": body.downloadType,
        "fileIndices":  json.dumps(body.fileIndices) if body.fileIndices else None,
    }

    # Start download in a background thread — don't block the HTTP response
    def _run():
        from streamlift_worker.downloader import (
            process_http_download,
            process_torrent_download,
        )
        try:
            if body.downloadType == "torrent":
                process_torrent_download(_config, task, _current_task)
            else:
                process_http_download(_config, task, _current_task)
        except Exception as e:
            logger.log("error", f"Download thread error: {e}")
        finally:
            # Release the single task slot on EVERY outcome (success included).
            # Not clearing it on success left the worker permanently latched to
            # the finished download id, so any later trigger got a 409
            # "Worker is busy" and the item never left `pending`.
            if _current_task.get("downloadId") == body.downloadId:
                _current_task.clear()

    t = threading.Thread(target=_run, daemon=True)
    t.start()

    return {"success": True, "downloadId": body.downloadId}


# ── DELETE /download/{download_id} ────────────────────────────────────────────

@app.delete("/download/{download_id}")
async def cancel_download(
    download_id: str,
    x_session_token: Optional[str] = Header(default=None),
):
    _require_session_token(x_session_token)

    current_id = _current_task.get("downloadId")
    if current_id != download_id:
        raise HTTPException(
            status_code=404,
            detail=f"No active download with id {download_id}",
        )

    _cancel_flags[download_id] = True
    logger.log("info", f"Cancel requested for download {download_id}")
    return {"success": True, "downloadId": download_id}


# ── POST /downloads/{download_id}/share ───────────────────────────────────────

@app.post("/downloads/{download_id}/share")
async def create_download_share_link(
    download_id: str,
    body: ShareLinkRequest,
    x_session_token: Optional[str] = Header(default=None),
):
    """Create a public MEGA share link for an uploaded node.

    Called by the frontend when the user clicks the share (link) icon on a
    download this worker uploaded. Uses this process's in-memory node registry
    (with a by-name fallback), persists the URL via the backend, and returns it.
    """
    _require_session_token(x_session_token)
    if not _config:
        raise HTTPException(status_code=503, detail="Worker not initialised yet")
    from streamlift_worker import api, mega

    share_url = mega.create_node_share_link(_config, download_id, body.fileName)
    if not share_url:
        raise HTTPException(
            status_code=404,
            detail="Could not locate the uploaded node for this download",
        )
    api.report_share_link(_config, download_id, share_url)
    logger.log("info", f"Share link created for download {download_id}")
    return {"success": True, "shareUrl": share_url}


# ── POST /file-info ───────────────────────────────────────────────────────────

@app.post("/file-info")
async def worker_file_info(
    body: FileInfoRequest,
    x_session_token: Optional[str] = Header(default=None),
):
    """Probe an HTTP(S) URL and return {fileName, fileSize, fileType, fileExtension}.

    Mirrors the Express backend's file-info response so the frontend can swap
    providers based on the chosen download location. HEAD first, then a 0-byte
    range GET fallback — never downloads the actual file.
    """
    _require_session_token(x_session_token)
    valid = body.url.startswith(("http://", "https://"))
    if not valid:
        raise HTTPException(status_code=400, detail="Only http/https URLs are supported")
    from streamlift_worker import file_info

    try:
        info = file_info.fetch_http_file_info(body.url)
    except TimeoutError:
        raise HTTPException(status_code=504, detail="Request timed out fetching file info")
    except Exception as e:
        logger.log("error", f"file-info failed for {body.url}: {e}")
        raise HTTPException(status_code=502, detail="Could not reach the URL")
    if info is None:
        raise HTTPException(status_code=502, detail="Could not fetch file info")
    return info


# ── POST /torrent-metadata ────────────────────────────────────────────────────

@app.post("/torrent-metadata")
async def worker_torrent_metadata(
    body: TorrentMetadataRequest,
    x_session_token: Optional[str] = Header(default=None),
):
    """Resolve a magnet link via aria2c and return the Express-shaped metadata.

    The response ``data`` payload matches ``POST /api/torrent-download/metadata``
    exactly: ``{name, infoHash, totalSize, totalSizeFormatted, fileCount, files}``.
    The expensive aria2c metadata phase runs in a thread pool so the SSE/status
    endpoints stay responsive.
    """
    _require_session_token(x_session_token)
    if not body.magnetLink.startswith("magnet:?"):
        raise HTTPException(status_code=400, detail="Invalid magnet link format")
    from streamlift_worker import aria2c_stream

    async def _resolve():
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            aria2c_stream.fetch_torrent_metadata,
            body.magnetLink,
            aria2c_stream._bt_tracker_map(),
        )

    try:
        metadata = await _resolve()
    except RuntimeError as e:
        raise HTTPException(
            status_code=503,
            detail=f"aria2c is not available and could not be installed: {e}",
        )
    if metadata is None:
        raise HTTPException(
            status_code=408,
            detail="Timeout: Could not fetch metadata. Torrent might be dead or have no seeders.",
        )
    return {"status": True, "message": "Metadata fetched successfully", "data": metadata}


# ── POST /internal/rotate-token ───────────────────────────────────────────────

class RotateTokenRequest(BaseModel):
    newSessionToken: str


@app.post("/internal/rotate-token")
async def rotate_token(
    body: RotateTokenRequest,
    x_auth_token: Optional[str] = Header(default=None),
):
    global _session_token
    _require_auth_token(x_auth_token)

    if not body.newSessionToken:
        raise HTTPException(status_code=400, detail="newSessionToken is required")

    _session_token = body.newSessionToken
    logger.log("info", "Session token rotated successfully")
    return {"success": True}
