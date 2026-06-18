!pip install requests psutil
!pip install git+https://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@github.com/shubhra92/megapy.git

#!/usr/bin/env python3
"""
Stream Lift Worker Script v{{WORKER_VERSION}}
Auto-generated worker for distributed download processing.
Run this script in Google Colab to connect to your Stream Lift backend.

Run this in a cell BEFORE running the worker:
  !pip install requests psutil
  !pip install git+https://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@github.com/shubhra92/megapy.git
"""

import os
import sys
import re
import io
import time
import json
import shutil
import tempfile
import subprocess
import threading
import requests
import psutil
from datetime import datetime
from typing import Optional, Dict, Any, List

# ============================================================================
# WORKER CONFIGURATION  (Auto-generated — keep this script private)
# ============================================================================

WORKER_ID         = "{{WORKER_ID}}"
AUTH_TOKEN        = "{{AUTH_TOKEN}}"
API_BASE_URL      = "{{API_BASE_URL}}"       # e.g. https://your-app.vercel.app
COMPUTE_TYPE      = "{{COMPUTE_TYPE}}"       # low | medium | high
DOWNLOAD_LOCATION = "{{DOWNLOAD_LOCATION}}"  # local | mega
# Mega credentials are pre-decrypted at script generation time.
# Never log or print these values.
MEGA_EMAIL     = "{{MEGA_EMAIL}}"
MEGA_PASSWORD  = "{{MEGA_PASSWORD}}"
WORKER_VERSION = "{{WORKER_VERSION}}"
SCRIPT_BUILD   = "{{SCRIPT_BUILD}}"   # timestamp when this script was generated

COMPUTE_CONFIG: Dict[str, Dict] = {
    "low":    {"max_cpu_pct": 25,  "chunk_size": 512  * 1024},   # 512 KB
    "medium": {"max_cpu_pct": 50,  "chunk_size": 1024 * 1024},   # 1 MB
    "high":   {"max_cpu_pct": 100, "chunk_size": 2048 * 1024},   # 2 MB
}

POLL_INTERVAL      = 10   # seconds between main-loop heartbeats
MAX_RETRIES        = 3
RETRY_DELAY        = 5    # seconds (multiplied by attempt number)
MAX_LOG_QUEUE      = 50
HEARTBEAT_INTERVAL = 8    # background thread heartbeat interval

# ============================================================================
# GLOBALS
# ============================================================================

log_queue: List[Dict] = []
current_task: Optional[Dict] = None
_net_snapshot: Optional[tuple] = None
_stop_event = threading.Event()

# ============================================================================
# UTILITIES
# ============================================================================

def get_public_ip() -> str:
    try:
        r = requests.get("https://api.ipify.org?format=json", timeout=5)
        return r.json().get("ip", "unknown")
    except Exception:
        return "unknown"

def get_system_metrics() -> Dict:
    global _net_snapshot
    cpu = psutil.cpu_percent(interval=0.3)
    mem = psutil.virtual_memory().percent
    net = psutil.net_io_counters()
    now = time.time()

    dl_speed = ul_speed = 0.0
    if _net_snapshot is not None:
        prev_recv, prev_sent, prev_time = _net_snapshot
        elapsed = max(now - prev_time, 0.001)
        dl_speed = max(0.0, (net.bytes_recv - prev_recv) / elapsed)
        ul_speed = max(0.0, (net.bytes_sent - prev_sent) / elapsed)

    _net_snapshot = (net.bytes_recv, net.bytes_sent, now)
    return {
        "cpuUsage":      round(cpu, 1),
        "ramUsage":      round(mem, 1),
        "downloadSpeed": round(dl_speed, 0),
        "uploadSpeed":   round(ul_speed, 0),
        "timestamp":     datetime.utcnow().isoformat() + "Z",
    }

def log(level: str, message: str) -> None:
    global log_queue
    entry = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "level":     level,
        "message":   message,
    }
    print(f"[{entry['timestamp']}] [{level.upper():7s}] {message}", flush=True)
    log_queue.append(entry)
    if len(log_queue) > MAX_LOG_QUEUE:
        log_queue = log_queue[-MAX_LOG_QUEUE:]

# ============================================================================
# MEGA UPLOAD  (uses mega.py with upload_stream — !pip install mega.py)
# ============================================================================

_mega_client = None  # lazy singleton

def _save_mega_session(session_id: str) -> None:
    """Persist the mega.py session SID to the backend so it survives restarts."""
    try:
        api_post("/api/worker/mega-session", {
            "workerId":    WORKER_ID,
            "authToken":   AUTH_TOKEN,
            "email":       MEGA_EMAIL,
            "sessionData": session_id,
        })
        log("info", "Mega session saved to backend")
    except Exception as e:
        log("warning", f"Could not save Mega session: {e}")

def _load_mega_session() -> Optional[str]:
    """Fetch a previously saved Mega session SID from the backend."""
    try:
        url = (
            f"{API_BASE_URL}/api/worker/mega-session"
            f"?workerId={WORKER_ID}&authToken={AUTH_TOKEN}"
        )
        r = requests.get(url, timeout=15)
        if r.status_code == 200:
            data = r.json()
            if data.get("success") and data.get("sessionData"):
                return data["sessionData"]
    except Exception as e:
        log("warning", f"Could not load Mega session: {e}")
    return None

def get_mega_client():
    """
    Return a logged-in mega.py client (lazy singleton).
    1. Try to restore from saved session (avoids re-login).
    2. Fall back to fresh login with credentials.
    3. Save the new session for next time.
    """
    global _mega_client
    if _mega_client is not None:
        return _mega_client

    if not MEGA_EMAIL or not MEGA_PASSWORD:
        raise RuntimeError("Mega credentials are not configured for this worker")

    try:
        from mega import Mega
    except ImportError:
        raise RuntimeError("mega.py not installed. Run: !pip install mega.py")

    # ── Try session restore first ─────────────────────────────────────────
    saved_sid = _load_mega_session()
    if saved_sid:
        try:
            log("info", "Restoring Mega session from backend...")
            m = Mega()
            client = m.login(session=saved_sid)
            _mega_client = client
            log("info", "Mega session restored successfully")
            return _mega_client
        except Exception as e:
            log("warning", f"Session restore failed ({e}), falling back to fresh login")
            _mega_client = None

    # ── Fresh login ───────────────────────────────────────────────────────
    log("info", f"Logging in to Mega as {MEGA_EMAIL}...")
    m = Mega()
    client = m.login(MEGA_EMAIL, MEGA_PASSWORD)
    _mega_client = client
    log("info", "Mega login successful")

    # Save session SID for next time
    try:
        sid = client.sid
        if sid:
            _save_mega_session(sid)
    except Exception as e:
        log("warning", f"Could not save session SID: {e}")

    return _mega_client

def stream_to_mega(stream, file_size: int, file_name: str) -> bool:
    """
    Stream binary data directly to Mega without writing to disk.
    Uses upload_stream(stream, size, name) from the patched mega.py fork.
    Falls back to buffering in memory if upload_stream is unavailable.
    Returns True on success.
    """
    global _mega_client
    size_mb = file_size / 1024 / 1024
    log("info", f"Streaming to Mega: {file_name} ({size_mb:.1f} MB) — no local disk write")
    try:
        client = get_mega_client()

        if hasattr(client, "upload_stream"):
            # ── Preferred: true streaming, zero disk ─────────────────────
            client.upload_stream(stream, file_size, file_name)
        else:
            # ── Fallback: buffer into BytesIO then upload ─────────────────
            # This happens if the old mega.py is installed without upload_stream.
            # Re-run:  !pip install --force-reinstall git+https://...@github.com/shubhra92/megapy.git
            log("warning", "upload_stream not found — buffering into memory (upgrade mega.py to use streaming)")
            buf = io.BytesIO(stream.read(-1))
            buf.seek(0)
            # mega.py upload() only accepts a file path, so write to a temp file
            with tempfile.NamedTemporaryFile(delete=False, suffix="_" + file_name) as tmp:
                tmp.write(buf.read())
                tmp_path = tmp.name
            try:
                client.upload(tmp_path)
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)

        log("info", f"Mega stream upload complete: {file_name}")
        return True

    except Exception as e:
        log("error", f"Mega stream upload failed: {e}")
        _mega_client = None
        return False

def upload_file_to_mega(file_path: str, file_name: str) -> bool:
    """
    Stream-upload a local file to Mega and delete it afterwards.
    Uses upload_stream with an open file handle — avoids loading into memory.
    Returns True on success.
    """
    global _mega_client
    try:
        file_size = os.path.getsize(file_path)
        log("info", f"Uploading {file_name} to Mega via stream ({file_size/1024/1024:.1f} MB)")
        with open(file_path, "rb") as f:
            ok = stream_to_mega(f, file_size, file_name)

        if ok:
            try:
                os.remove(file_path)
                log("info", f"Local file deleted after Mega upload: {file_path}")
            except Exception as e:
                log("warning", f"Could not delete local file: {e}")
        return ok
    except Exception as e:
        log("error", f"Mega file upload failed: {e}")
        _mega_client = None
        return False

# ============================================================================
# API COMMUNICATION
# ============================================================================

def api_post(endpoint: str, data: Dict) -> Optional[Dict]:
    url = f"{API_BASE_URL}{endpoint}"
    headers = {"Content-Type": "application/json"}

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = requests.post(url, json=data, headers=headers, timeout=30)
            if r.status_code == 401:
                log("error", "Authentication failed — invalid WORKER_ID or AUTH_TOKEN. Stopping.")
                _stop_event.set()
                sys.exit(1)
            if r.status_code >= 500:
                raise requests.RequestException(f"Server error {r.status_code}")
            return r.json()
        except requests.RequestException as e:
            log("warning", f"POST {endpoint} failed (attempt {attempt}/{MAX_RETRIES}): {e}")
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY * attempt)

    log("error", f"POST {endpoint} gave up after {MAX_RETRIES} attempts")
    return None

# ============================================================================
# WORKER LIFECYCLE
# ============================================================================

def register() -> bool:
    log("info", "Registering worker with Stream Lift backend...")
    ip = get_public_ip()
    result = api_post("/api/worker/register", {
        "workerId":  WORKER_ID,
        "authToken": AUTH_TOKEN,
        "ipAddress": ip,
        "version":   WORKER_VERSION,
    })
    if result and result.get("success"):
        log("info", f"Registered successfully. Public IP: {ip}")
        return True
    log("error", f"Registration failed. Response: {result}")
    return False

def send_heartbeat() -> Optional[Dict]:
    metrics = get_system_metrics()
    payload: Dict[str, Any] = {
        "workerId":  WORKER_ID,
        "authToken": AUTH_TOKEN,
        "metrics":   metrics,
    }
    if current_task:
        payload["currentTask"] = current_task
    return api_post("/api/worker/heartbeat", payload)

def flush_logs() -> None:
    global log_queue
    if not log_queue:
        return
    batch = log_queue[:10]
    result = api_post("/api/worker/logs", {
        "workerId":  WORKER_ID,
        "authToken": AUTH_TOKEN,
        "logs":      batch,
    })
    if result and result.get("success"):
        log_queue = log_queue[10:]

def report_progress(
    download_id: str,
    downloaded: int,
    total: int,
    status: str,
    file_name: str = "",
    error_msg: str = "",
) -> None:
    pct = round((downloaded / total * 100), 2) if total > 0 else 0
    payload: Dict[str, Any] = {
        "workerId":   WORKER_ID,
        "authToken":  AUTH_TOKEN,
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
    api_post("/api/worker/download-progress", payload)

def _heartbeat_loop() -> None:
    while not _stop_event.is_set():
        try:
            send_heartbeat()
            flush_logs()
        except Exception as e:
            log("warning", f"Background heartbeat error: {e}")
        _stop_event.wait(timeout=HEARTBEAT_INTERVAL)

# ============================================================================
# HTTP DOWNLOAD
# ============================================================================

def process_http_download(task: Dict) -> None:
    global current_task

    download_id = task["downloadId"]
    source_url  = task["sourceUrl"]
    file_name   = task.get("fileName") or "download"
    chunk_size  = COMPUTE_CONFIG[COMPUTE_TYPE]["chunk_size"]

    log("info", f"Starting HTTP download: {file_name} → {DOWNLOAD_LOCATION}")
    current_task = {
        "downloadId": download_id,
        "fileName":   file_name,
        "status":     "downloading",
        "progress":   0,
        "startedAt":  datetime.utcnow().isoformat() + "Z",
    }

    try:
        resp = requests.get(source_url, stream=True, timeout=30)
        resp.raise_for_status()

        total = int(resp.headers.get("content-length", 0))

        # ── Mega: stream directly — no local file at all ──────────────────
        if DOWNLOAD_LOCATION == "mega":
            if total == 0:
                raise RuntimeError(
                    "Cannot stream to Mega: server did not return Content-Length. "
                    "Mega requires the file size upfront."
                )

            log("info", f"Streaming {file_name} directly to Mega ({total/1024/1024:.1f} MB) — no disk write")
            report_progress(download_id, 0, total, "downloading", file_name)

            class _ProgressStream:
                """Wraps the response raw stream, tracking bytes read and reporting progress."""
                def __init__(self, raw, total_bytes: int):
                    self._raw        = raw
                    self._total      = total_bytes
                    self._downloaded = 0
                    self._last_report = time.time()

                def read(self, n: int = -1) -> bytes:
                    chunk = self._raw.read(n)
                    if chunk:
                        self._downloaded += len(chunk)
                        pct = self._downloaded / self._total * 100
                        current_task["progress"] = round(pct, 2)

                        now = time.time()
                        if now - self._last_report >= 10:
                            mem_mb = psutil.virtual_memory().used / 1024 / 1024
                            log("info",
                                f"📊 {pct:.1f}% | "
                                f"{self._downloaded/1024/1024:.1f} MB / {self._total/1024/1024:.1f} MB | "
                                f"RAM: {mem_mb:.0f} MB")
                            report_progress(download_id, self._downloaded, self._total,
                                            "downloading", file_name)
                            self._last_report = now
                    return chunk

            stream = _ProgressStream(resp.raw, total)
            current_task["status"] = "uploading"
            ok = stream_to_mega(stream, total, file_name)

            if not ok:
                report_progress(download_id, 0, total, "failed", file_name,
                                "Mega stream upload failed — check logs")
                return

            report_progress(download_id, total, total, "completed", file_name)
            log("info", f"HTTP→Mega stream completed: {file_name}")
            return

        # ── Local: write to Colab disk ────────────────────────────────────
        downloaded        = 0
        last_report_bytes = 0
        last_report_time  = time.time()

        save_dir  = "/content" if os.path.exists("/content") else os.getcwd()
        file_path = os.path.join(save_dir, file_name)

        with open(file_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=chunk_size):
                if not chunk:
                    continue
                f.write(chunk)
                downloaded += len(chunk)
                pct = (downloaded / total * 100) if total > 0 else 0
                current_task["progress"] = round(pct, 2)

                bytes_since = downloaded - last_report_bytes
                time_since  = time.time() - last_report_time
                if bytes_since >= 5 * 1024 * 1024 or time_since >= 15:
                    mem_mb = psutil.virtual_memory().used / 1024 / 1024
                    log("info",
                        f"📊 {pct:.1f}% | "
                        f"{downloaded/1024/1024:.1f} MB / {total/1024/1024:.1f} MB | "
                        f"RAM: {mem_mb:.0f} MB")
                    report_progress(download_id, downloaded, total, "downloading", file_name)
                    last_report_bytes = downloaded
                    last_report_time  = time.time()

        report_progress(download_id, downloaded, total, "completed", file_name)
        log("info", f"HTTP download completed locally: {file_name} ({downloaded:,} bytes)")

    except Exception as e:
        log("error", f"HTTP download failed: {e}")
        report_progress(download_id, 0, 0, "failed", file_name, str(e))
        # Clean up partial local file if any
        save_dir  = "/content" if os.path.exists("/content") else os.getcwd()
        file_path = os.path.join(save_dir, file_name)
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
            except Exception:
                pass
    finally:
        current_task = None

# ============================================================================
# TORRENT DOWNLOAD  (uses aria2c — pre-installed in Google Colab)
# ============================================================================

def _collect_downloaded_files(
    save_path: str,
    aria2c_reported_path: Optional[str],
    display_name: str,
) -> List[str]:
    """
    Collect all downloaded files after aria2c finishes.
    Returns a list of absolute file paths (never directories).
    aria2c may place files:
      - Directly in save_path  (single file torrent)
      - Inside a subdirectory  (multi-file torrent)
    """

    def _files_in(path: str) -> List[str]:
        """Recursively collect all files inside path (or return [path] if it's a file)."""
        if not path or not os.path.exists(path):
            return []
        if os.path.isfile(path):
            return [path]
        # It's a directory — walk recursively
        result = []
        for root, _, filenames in os.walk(path):
            for fname in filenames:
                result.append(os.path.join(root, fname))
        return sorted(result)  # stable order

    # 1. aria2c's "Download complete:" line (may be a file or directory)
    if aria2c_reported_path:
        found = _files_in(aria2c_reported_path)
        if found:
            return found

    # 2. save_path/display_name
    found = _files_in(os.path.join(save_path, display_name))
    if found:
        return found

    # 3. Scan save_path for most recently modified entry
    try:
        entries = [os.path.join(save_path, e) for e in os.listdir(save_path)]
        entries = [e for e in entries if os.path.exists(e)]
        if entries:
            newest = max(entries, key=os.path.getmtime)
            found = _files_in(newest)
            if found:
                return found
    except OSError:
        pass

    return []

def _check_aria2c() -> bool:
    return shutil.which("aria2c") is not None

def _install_aria2c() -> None:
    log("info", "aria2c not found — attempting install via apt-get...")
    try:
        subprocess.run(["apt-get", "install", "-y", "aria2"],
                       check=True, capture_output=True)
        log("info", "aria2c installed successfully")
    except Exception as e:
        log("error", f"Could not install aria2c: {e}")

def process_torrent_download(task: Dict) -> None:
    global current_task

    download_id      = task["downloadId"]
    magnet_link      = task["sourceUrl"]
    file_name        = task.get("fileName") or ""
    file_indices_raw = task.get("fileIndices")

    # Parse file indices — DB stores 0-based, aria2c --select-file is 1-based
    file_indices: Optional[List[int]] = None
    if file_indices_raw:
        try:
            parsed = (json.loads(file_indices_raw)
                      if isinstance(file_indices_raw, str)
                      else file_indices_raw)
            if isinstance(parsed, list) and len(parsed) > 0:
                file_indices = [i + 1 for i in parsed]
        except Exception as e:
            log("warning", f"Could not parse fileIndices: {e}")

    display_name = file_name or "torrent"
    log("info", f"Starting torrent download via aria2c: {display_name} → {DOWNLOAD_LOCATION}")

    current_task = {
        "downloadId": download_id,
        "fileName":   display_name,
        "status":     "downloading",
        "progress":   0,
        "startedAt":  datetime.utcnow().isoformat() + "Z",
    }

    if not _check_aria2c():
        _install_aria2c()
    if not _check_aria2c():
        msg = "aria2c is not available. Run: !apt-get install -y aria2"
        log("error", msg)
        report_progress(download_id, 0, 0, "failed", display_name, msg)
        current_task = None
        return

    save_path = "/content" if os.path.exists("/content") else os.getcwd()

    cmd = [
        "aria2c",
        "--dir", save_path,
        "--seed-time=0",
        "--max-connection-per-server=4",
        "--split=4",
        "--bt-stop-timeout=300",
        "--console-log-level=notice",
        "--summary-interval=5",
        "--show-console-readout=true",
        "--allow-overwrite=true",
        "--auto-file-renaming=false",
    ]
    # IMPORTANT: --select-file must come BEFORE the magnet link URI
    if file_indices:
        select_str = ",".join(str(i) for i in file_indices)
        cmd += ["--select-file", select_str]
        log("info", f"Selecting files: {select_str}")

    cmd.append(magnet_link)

    log("info", "aria2c started — waiting for peers...")

    # Clean up any leftover .aria2 control files from previous attempts
    # that could cause aria2c to fail or behave unexpectedly
    try:
        for entry in os.listdir(save_path):
            if entry.endswith(".aria2"):
                stale = os.path.join(save_path, entry)
                os.remove(stale)
                log("info", f"Removed stale aria2c control file: {entry}")
    except Exception:
        pass

    progress_re = re.compile(r'\[#\w+\s+([\d.]+\w+)/([\d.]+\w+)\((\d+)%\)')

    def parse_size(s: str) -> int:
        units = {
            "B": 1,
            "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "TiB": 1024**4,
            "KB":  1000, "MB":  1000**2,  "GB":  1000**3,  "TB":  1000**4,
        }
        m = re.match(r'([\d.]+)(\w+)', s)
        if not m:
            return 0
        val, unit = float(m.group(1)), m.group(2)
        return int(val * units.get(unit, 1))

    total_bytes = downloaded_bytes = 0
    last_report_time = time.time()
    downloaded_file_path: Optional[str] = None

    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        for line in process.stdout:  # type: ignore[union-attr]
            line = line.rstrip()
            if line:
                print(line, flush=True)

            # Capture the saved file path from aria2c output
            # aria2c prints: "Download complete: /content/filename.mkv"
            if "Download complete:" in line:
                downloaded_file_path = line.split("Download complete:")[-1].strip()

            m = progress_re.search(line)
            if m:
                downloaded_bytes = parse_size(m.group(1))
                total_bytes      = parse_size(m.group(2))
                pct              = int(m.group(3))
                current_task["progress"] = pct

                now = time.time()
                if now - last_report_time >= 10:
                    mem_mb = psutil.virtual_memory().used / 1024 / 1024
                    log("info",
                        f"📊 {pct}% | "
                        f"{downloaded_bytes/1024/1024:.1f} MB / {total_bytes/1024/1024:.1f} MB | "
                        f"RAM: {mem_mb:.0f} MB")
                    report_progress(download_id, downloaded_bytes, total_bytes,
                                    "downloading", display_name)
                    last_report_time = now

        process.wait()

        if process.returncode != 0:
            msg = f"aria2c exited with code {process.returncode}"
            log("error", msg)
            report_progress(download_id, downloaded_bytes, total_bytes,
                            "failed", display_name, msg)
            return

        log("info", f"Torrent download finished locally: {display_name}")

        # ── Upload to Mega if configured ──────────────────────────────────
        if DOWNLOAD_LOCATION == "mega":
            current_task["status"] = "uploading"
            report_progress(download_id, total_bytes, total_bytes, "uploading", display_name)

            files_to_upload = _collect_downloaded_files(
                save_path, downloaded_file_path, display_name
            )

            if not files_to_upload:
                log("warning", "Could not locate any downloaded files for Mega upload")
            elif len(files_to_upload) == 1:
                # ── Single file — upload directly, no folder needed ───────
                fp = files_to_upload[0]
                log("info", f"Single file upload: {os.path.basename(fp)}")
                success = upload_file_to_mega(fp, os.path.basename(fp))
                if not success:
                    report_progress(download_id, total_bytes, total_bytes, "failed",
                                    display_name, "Mega upload failed — check logs")
                    return
            else:
                # ── Multiple files — create a Mega folder first ───────────
                folder_name = display_name
                log("info", f"Multi-file upload: creating Mega folder '{folder_name}' for {len(files_to_upload)} files")

                try:
                    client = get_mega_client()
                    client.create_folder(folder_name)
                    # find() returns the folder node as a (handle, node_data) tuple
                    folder_node = client.find(folder_name)
                    if folder_node is None:
                        raise RuntimeError(f"Folder '{folder_name}' not found after creation")
                    folder_handle = folder_node[0]
                    log("info", f"Mega folder ready: {folder_name}")
                except Exception as e:
                    log("error", f"Failed to create Mega folder: {e}")
                    report_progress(download_id, total_bytes, total_bytes, "failed",
                                    display_name, f"Mega folder creation failed: {e}")
                    return

                for i, fp in enumerate(files_to_upload, 1):
                    fname = os.path.basename(fp)
                    fsize = os.path.getsize(fp)
                    log("info", f"Uploading file {i}/{len(files_to_upload)}: {fname} ({fsize/1024/1024:.2f} MB)")

                    try:
                        with open(fp, "rb") as f:
                            if hasattr(client, "upload_stream"):
                                client.upload_stream(f, fsize, fname, dest=folder_handle)
                            else:
                                # Fallback: upload() with dest — saves to folder
                                client.upload(fp, dest=folder_handle)
                        log("info", f"Uploaded: {fname}")
                        try:
                            os.remove(fp)
                        except Exception:
                            pass
                    except Exception as e:
                        log("error", f"Failed to upload {fname}: {e}")
                        report_progress(download_id, total_bytes, total_bytes, "failed",
                                        display_name, f"Upload failed for {fname}: {e}")
                        return

                log("info", f"All {len(files_to_upload)} files uploaded to Mega folder: {folder_name}")

        report_progress(download_id, total_bytes or downloaded_bytes,
                        total_bytes or downloaded_bytes, "completed", display_name)
        log("info", f"Torrent task completed: {display_name}")

    except Exception as e:
        log("error", f"Torrent download failed: {e}")
        report_progress(download_id, 0, 0, "failed", display_name, str(e))
    finally:
        current_task = None

# ============================================================================
# MAIN
# ============================================================================

def main() -> None:
    log("info", f"Stream Lift Worker v{WORKER_VERSION} (build {SCRIPT_BUILD}) starting")
    log("info", f"Compute type     : {COMPUTE_TYPE}")
    log("info", f"Download location: {DOWNLOAD_LOCATION}")
    log("info", f"API base URL     : {API_BASE_URL}")

    # Pre-validate Mega login if using Mega — fail fast before any download
    if DOWNLOAD_LOCATION == "mega":
        try:
            get_mega_client()
        except Exception as e:
            log("error", f"Mega setup failed at startup: {e}")
            log("error", "Fix credentials and regenerate the worker script.")
            sys.exit(1)

    if not register():
        sys.exit(1)

    hb_thread = threading.Thread(target=_heartbeat_loop, daemon=True)
    hb_thread.start()
    log("info", "Background heartbeat thread started")

    while not _stop_event.is_set():
        try:
            result = send_heartbeat()
            if result and result.get("success"):
                for task in result.get("newTasks", []):
                    dtype = task.get("downloadType", "http")
                    log("info", f"New task: {task.get('fileName', '?')} [{dtype}]")
                    if dtype == "torrent":
                        process_torrent_download(task)
                    else:
                        process_http_download(task)

            flush_logs()
            _stop_event.wait(timeout=POLL_INTERVAL)

        except KeyboardInterrupt:
            log("info", "Worker stopped by user.")
            _stop_event.set()
            break
        except Exception as e:
            log("error", f"Unexpected error in main loop: {e}")
            _stop_event.wait(timeout=POLL_INTERVAL)

if __name__ == "__main__":
    main()
