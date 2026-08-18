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
  POST /internal/rotate-token         — auth token (internal use only)
"""

import asyncio
import json
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


@app.get("/downloads/{download_id}/files/{file_index}")
async def download_completed_file(
    download_id: str,
    file_index: int,
    x_session_token: Optional[str] = Header(default=None),
    download_token: Optional[str] = None,
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

    # Only block if there's an active task for a DIFFERENT download
    # (same downloadId = idempotent retry, allow it through)
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
