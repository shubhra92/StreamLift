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


def _get(api_base_url: str, endpoint: str, params: dict[str, Any] | None = None) -> Optional[dict]:
    url = f"{api_base_url}{endpoint}"
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code == 200:
            return r.json()
    except requests.RequestException as e:
        logger.log("warning", f"GET {endpoint} failed: {e}")
    return None


# ── Worker lifecycle ──────────────────────────────────────────────────────────

def register(config: WorkerConfig, ip_address: str, pinggy_url: str) -> Optional[str]:
    """
    Register with the backend. Returns the session_token on success, None on failure.
    """
    result = _post(config, "/api/worker/register", {
        "workerId":   config.worker_id,
        "authToken":  config.auth_token,
        "ipAddress":  ip_address,
        "version":    config.worker_version,
        "pinggyUrl":  pinggy_url,
    })
    if result and result.get("success"):
        session_token = result.get("sessionToken", "")
        logger.log("info", f"Registered successfully. Public IP: {ip_address}")
        return session_token
    logger.log("error", f"Registration failed. Response: {result}")
    return None


def heartbeat(config: WorkerConfig, metrics: dict, pinggy_url: str, uptime_seconds: int = 0) -> None:
    """
    Send heartbeat — updates last_heartbeat + pinggy_url in DB.
    No longer returns newTasks — task dispatch is triggered by client directly.
    """
    _post(config, "/api/worker/heartbeat", {
        "workerId":  config.worker_id,
        "authToken": config.auth_token,
        "pinggyUrl": pinggy_url,
        "uptimeSeconds": uptime_seconds,
        # metrics removed — delivered via SSE stream only
    })


def status_update(
    config: WorkerConfig,
    download_id: str,
    status: str,
    error_msg: str = "",
    location_path: str | None = None,
) -> None:
    """Notify the backend when a download completes or fails."""
    payload: dict[str, Any] = {
        "workerId":   config.worker_id,
        "authToken":  config.auth_token,
        "downloadId": download_id,
        "status":     status,
    }
    if error_msg:
        payload["errorMessage"] = error_msg
    if location_path:
        payload["locationPath"] = location_path
    _post(config, "/api/worker/status-update", payload)


# ── Bootstrap config ──────────────────────────────────────────────────────────

def fetch_worker_config(worker_id: str, auth_token: str, api_base_url: str) -> Optional[dict]:
    """Fetch bootstrap config (location, compute, pinggy token, mega session)."""
    data = _get(api_base_url, "/api/worker/config", {
        "workerId":  worker_id,
        "authToken": auth_token,
    })
    if data and data.get("success") and isinstance(data.get("data"), dict):
        return data["data"]
    logger.log("warning", "Could not fetch worker config from backend")
    return None


# ── Mega session persistence ──────────────────────────────────────────────────

def save_mega_session(config: WorkerConfig, session_data: Any) -> None:
    """Persist a Mega session dict to the backend for later restore."""
    import json

    try:
        # Send as JSON string — the backend stores this in a JSON column.
        payload = session_data if isinstance(session_data, dict) else {"sid": str(session_data)}
        _post(config, "/api/worker/mega-session", {
            "workerId":    config.worker_id,
            "authToken":   config.auth_token,
            "email":       config.mega_email,
            "sessionData": json.dumps(payload),
        })
        logger.log("info", "Mega session saved to backend")
    except Exception as e:
        logger.log("warning", f"Could not save Mega session: {e}")


def load_mega_session(config: WorkerConfig) -> Any:
    """Load a saved Mega session, returning a dict or None.

    Prefers the browser-minted session stored on the worker row (session-only
    workers); falls back to the legacy mega_sessions table.
    """
    import json

    cfg = fetch_worker_config(config.worker_id, config.auth_token, config.api_base_url)
    if cfg:
        session = cfg.get("megaSession")
        if isinstance(session, dict):
            return session
        if isinstance(session, str):
            try:
                return json.loads(session)
            except (json.JSONDecodeError, TypeError):
                return None

    data = _get(config.api_base_url, "/api/worker/mega-session", {
        "workerId":  config.worker_id,
        "authToken": config.auth_token,
    })
    if data and data.get("success") and data.get("sessionData"):
        raw = data["sessionData"]
        if isinstance(raw, dict):
            return raw
        if isinstance(raw, str):
            try:
                return json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                return None
    return None


def delete_mega_session(config: WorkerConfig) -> None:
    """Purge the Mega session saved on the backend (e.g. it went stale/expired)."""
    try:
        _post(config, "/api/worker/mega-session", {
            "workerId":    config.worker_id,
            "authToken":   config.auth_token,
            "email":       config.mega_email,
            "sessionData": None,
        })
        logger.log("info", "Stale Mega session cleared from backend")
    except Exception as e:
        logger.log("warning", f"Could not clear stale Mega session: {e}")


def report_mega_needs_relink(config: WorkerConfig, reason: str = "") -> None:
    """Tell the backend the worker's Mega session is broken and needs re-linking."""
    try:
        _post(config, "/api/worker/mega-status", {
            "workerId":     config.worker_id,
            "authToken":    config.auth_token,
            "needsRelink":  True,
            "reason":       reason,
        })
        logger.log("warning", f"Signalled Mega re-link request: {reason}")
    except Exception as e:
        logger.log("warning", f"Could not signal Mega re-link: {e}")
