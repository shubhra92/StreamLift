"""
HTTP communication with the StreamLift backend.
All outbound calls live here — the rest of the package never calls requests directly.
"""

import sys
import threading
import time
from typing import Any, Optional

import requests

from streamlift_worker import logger
from streamlift_worker.config import MAX_RETRIES, RETRY_DELAY, WorkerConfig

# Shared stop event — set by the auth-failure handler so every loop exits cleanly
stop_event = threading.Event()


def _post(config: WorkerConfig, endpoint: str, data: dict[str, Any]) -> Optional[dict]:
    url     = f"{config.api_base_url}{endpoint}"
    headers = {"Content-Type": "application/json"}

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = requests.post(url, json=data, headers=headers, timeout=30)

            if r.status_code == 401:
                logger.log("error", "Authentication failed — invalid worker ID or auth token. Stopping.")
                stop_event.set()
                sys.exit(1)

            if r.status_code >= 500:
                raise requests.RequestException(f"Server error {r.status_code}")

            return r.json()

        except requests.RequestException as e:
            logger.log("warning", f"POST {endpoint} failed (attempt {attempt}/{MAX_RETRIES}): {e}")
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY * attempt)

    logger.log("error", f"POST {endpoint} gave up after {MAX_RETRIES} attempts")
    return None


def _get(config: WorkerConfig, endpoint: str, params: dict[str, Any] | None = None) -> Optional[dict]:
    url = f"{config.api_base_url}{endpoint}"
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code == 200:
            return r.json()
    except requests.RequestException as e:
        logger.log("warning", f"GET {endpoint} failed: {e}")
    return None


# ── Worker lifecycle ──────────────────────────────────────────────────────────

def register(config: WorkerConfig, ip_address: str) -> bool:
    result = _post(config, "/api/worker/register", {
        "workerId":  config.worker_id,
        "authToken": config.auth_token,
        "ipAddress": ip_address,
        "version":   config.worker_version,
    })
    if result and result.get("success"):
        logger.log("info", f"Registered successfully. Public IP: {ip_address}")
        return True
    logger.log("error", f"Registration failed. Response: {result}")
    return False


def heartbeat(config: WorkerConfig, current_task: Optional[dict], metrics: dict) -> Optional[dict]:
    payload: dict[str, Any] = {
        "workerId":  config.worker_id,
        "authToken": config.auth_token,
        "metrics":   metrics,
    }
    if current_task:
        payload["currentTask"] = current_task
    return _post(config, "/api/worker/heartbeat", payload)


def flush_logs(config: WorkerConfig) -> None:
    if logger.pending_count() == 0:
        return
    batch = logger.pop_batch(10)
    result = _post(config, "/api/worker/logs", {
        "workerId":  config.worker_id,
        "authToken": config.auth_token,
        "logs":      batch,
    })
    # If the call failed, put the batch back at the front so we retry next time
    if not (result and result.get("success")):
        from streamlift_worker.logger import _queue
        _queue[:0] = batch


def report_progress(
    config: WorkerConfig,
    download_id: str,
    downloaded: int,
    total: int,
    status: str,
    file_name: str = "",
    error_msg:  str = "",
) -> None:
    pct = round(downloaded / total * 100, 2) if total > 0 else 0
    payload: dict[str, Any] = {
        "workerId":   config.worker_id,
        "authToken":  config.auth_token,
        "downloadId": download_id,
        "progress": {
            "downloadedBytes": downloaded,
            "totalBytes":      total,
            "percent":         pct,
            "status":          status,
        },
    }
    if error_msg:
        payload["progress"]["errorMessage"] = error_msg
    _post(config, "/api/worker/download-progress", payload)


# ── Mega session persistence ──────────────────────────────────────────────────

def save_mega_session(config: WorkerConfig, session_id: str) -> None:
    try:
        _post(config, "/api/worker/mega-session", {
            "workerId":    config.worker_id,
            "authToken":   config.auth_token,
            "email":       config.mega_email,
            "sessionData": session_id,
        })
        logger.log("info", "Mega session saved to backend")
    except Exception as e:
        logger.log("warning", f"Could not save Mega session: {e}")


def load_mega_session(config: WorkerConfig) -> Optional[str]:
    data = _get(config, "/api/worker/mega-session", {
        "workerId":  config.worker_id,
        "authToken": config.auth_token,
    })
    if data and data.get("success") and data.get("sessionData"):
        return data["sessionData"]
    return None
