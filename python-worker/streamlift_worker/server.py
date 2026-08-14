"""
FastAPI server — exposes the worker's HTTP + SSE API.

Endpoints:
  GET  /health                        — unauthenticated
  GET  /status                        — session token
  GET  /stream                        — session token, SSE
  POST /download                      — session token
  DELETE /download/{download_id}      — session token
  POST /internal/rotate-token         — auth token (internal use only)
"""

import asyncio
import json
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from streamlift_worker import logger
from streamlift_worker.metrics import get_system_metrics

# ── Module-level state shared with worker.py ──────────────────────────────────

# Set by worker.py on startup
_config                          = None
_current_task: dict              = {}
_session_token: Optional[str]   = None   # short-lived, rotatable
_cancel_flags: dict[str, bool]  = {}     # download_id → True means cancel requested


def init_server(config, current_task: dict, initial_session_token: str) -> None:
    """Called once by worker.py before uvicorn starts."""
    global _config, _current_task, _session_token
    _config         = config
    _current_task   = current_task
    _session_token  = initial_session_token


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
