"""
Download handlers — HTTP and torrent.
Each handler reports progress back to the backend and handles cleanup.
On completion or failure, calls api.status_update() to notify the Next.js backend.
Respects cancel flags set via the worker's DELETE /download/{id} endpoint.
"""

import json
import os
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone
from typing import Optional

import psutil
import requests

from streamlift_worker import api, logger, mega
from streamlift_worker.config import WorkerConfig


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _colab_dir() -> str:
    """Return /content in Colab, or cwd elsewhere."""
    return "/content" if os.path.exists("/content") else os.getcwd()


def _downloads_dir() -> str:
    """Return the user-visible local download directory, creating it if needed."""
    path = os.path.join(_colab_dir(), "streamlift-downloads")
    os.makedirs(path, exist_ok=True)
    return path


def _partial_dir(download_id: str) -> str:
    """Create an isolated, hidden staging directory for one download job."""
    safe_id = re.sub(r"[^A-Za-z0-9_-]", "_", download_id)
    path = os.path.join(_downloads_dir(), ".partial", safe_id)
    shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path, exist_ok=True)
    return path


def _safe_file_name(name: str, fallback: str = "download") -> str:
    """Prevent a remote filename from escaping the worker's download directory."""
    cleaned = os.path.basename(name.replace("\\", "/")).strip()
    return cleaned if cleaned not in {"", ".", ".."} else fallback


def _available_path(path: str) -> str:
    """Avoid overwriting an existing completed download."""
    if not os.path.exists(path):
        return path
    directory, name = os.path.split(path)
    stem, ext = os.path.splitext(name)
    index = 2
    while True:
        candidate = os.path.join(directory, f"{stem} ({index}){ext}")
        if not os.path.exists(candidate):
            return candidate
        index += 1


def _publish_staged_file(staged_path: str, relative_path: str) -> str:
    """Atomically move a completed staged file into the visible downloads folder."""
    destination_root = _downloads_dir()
    safe_relative = os.path.normpath(relative_path).lstrip(os.sep)
    if safe_relative in {"", "."} or safe_relative.startswith(".." + os.sep):
        raise ValueError("Invalid downloaded file path")
    destination = _available_path(os.path.join(destination_root, safe_relative))
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    os.replace(staged_path, destination)
    return destination


def _publish_staged_tree(staging_dir: str) -> list[str]:
    """Move completed torrent payload files out of an isolated staging directory."""
    published: list[str] = []
    for root, _, names in os.walk(staging_dir):
        for name in names:
            # aria2 control files are not user-visible downloads.
            if name.endswith(".aria2"):
                continue
            source = os.path.join(root, name)
            relative = os.path.relpath(source, staging_dir)
            published.append(_publish_staged_file(source, relative))
    return published


def _is_cancelled(download_id: str) -> bool:
    """Check if a cancel was requested via the worker API."""
    try:
        from streamlift_worker.server import get_cancel_flag, clear_cancel_flag
        if get_cancel_flag(download_id):
            clear_cancel_flag(download_id)
            return True
    except Exception:
        pass
    return False


# ── HTTP download ─────────────────────────────────────────────────────────────

def process_http_download(config: WorkerConfig, task: dict, current_task: dict) -> None:
    download_id = task["downloadId"]
    source_url  = task["sourceUrl"]
    file_name   = _safe_file_name(task.get("fileName") or "download")
    staging_dir = _partial_dir(download_id) if config.download_location == "local" else None

    logger.log("info", f"HTTP download: {file_name} → {config.download_location}")
    current_task.update({
        "downloadId": download_id,
        "fileName":   file_name,
        "status":     "downloading",
        "progress":   0,
        "startedAt":  _now_iso(),
    })
    # Notify backend — DB status: pending → downloading
    api.status_update(config, download_id, "downloading")

    try:
        resp = requests.get(source_url, stream=True, timeout=30)
        resp.raise_for_status()
        total = int(resp.headers.get("content-length", 0))
        if config.download_location == "mega":
            _http_stream_to_mega(config, resp, total, download_id, file_name, current_task)
        else:
            _http_save_local(config, resp, total, download_id, file_name, current_task, staging_dir)

    except Exception as e:
        logger.log("error", f"HTTP download failed: {e}")
        api.status_update(config, download_id, "failed", str(e))
        if staging_dir:
            shutil.rmtree(staging_dir, ignore_errors=True)
    finally:
        current_task.clear()


def _http_stream_to_mega(
    config: WorkerConfig,
    resp: requests.Response,
    total: int,
    download_id: str,
    file_name: str,
    current_task: dict,
) -> None:
    if total == 0:
        raise RuntimeError(
            "Cannot stream to Mega: server did not return Content-Length. "
            "Mega requires the file size upfront."
        )

    logger.log("info", f"Streaming {file_name} directly to Mega ({total/1024/1024:.1f} MB) — no disk write")

    downloaded = 0
    last_report = time.time()

    class _ProgressStream:
        def read(self, n: int = -1) -> bytes:
            nonlocal downloaded, last_report
            chunk = resp.raw.read(n)
            if chunk:
                downloaded += len(chunk)
                pct = downloaded / total * 100
                current_task["progress"] = round(pct, 2)

                now = time.time()
                if now - last_report >= 10:
                    mem_mb = psutil.virtual_memory().used / 1024 / 1024
                    logger.log("info",
                        f"📊 {pct:.1f}% | "
                        f"{downloaded/1024/1024:.1f} / {total/1024/1024:.1f} MB | "
                        f"RAM: {mem_mb:.0f} MB")
                    last_report = now
            return chunk

    current_task["status"] = "uploading"
    ok = mega.stream_to_mega(config, _ProgressStream(), total, file_name)

    if ok:
        current_task["progress"] = 100
        current_task["status"]   = "completed"
        api.status_update(config, download_id, "completed")
        logger.log("info", f"HTTP→Mega stream completed: {file_name}")
    else:
        current_task["status"] = "failed"
        api.status_update(config, download_id, "failed", "Mega stream upload failed — check logs")


def _http_save_local(
    config: WorkerConfig,
    resp: requests.Response,
    total: int,
    download_id: str,
    file_name: str,
    current_task: dict,
    staging_dir: str | None,
) -> None:
    if not staging_dir:
        raise RuntimeError("Local download staging directory is unavailable")
    file_path = os.path.join(staging_dir, file_name)

    downloaded        = 0
    last_report_bytes = 0
    last_report_time  = time.time()

    with open(file_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=config.chunk_size):
            if not chunk:
                continue

            # Check cancel flag on each chunk
            if _is_cancelled(download_id):
                logger.log("info", f"Download cancelled: {file_name}")
                current_task["status"] = "failed"
                api.status_update(config, download_id, "failed", "Cancelled by user")
                _cleanup_local_file(staging_dir, file_name)
                return

            f.write(chunk)
            downloaded += len(chunk)
            pct = (downloaded / total * 100) if total > 0 else 0
            current_task["progress"] = round(pct, 2)

            bytes_since = downloaded - last_report_bytes
            time_since  = time.time() - last_report_time
            if bytes_since >= 5 * 1024 * 1024 or time_since >= 15:
                mem_mb = psutil.virtual_memory().used / 1024 / 1024
                logger.log("info",
                    f"📊 {pct:.1f}% | "
                    f"{downloaded/1024/1024:.1f} / {total/1024/1024:.1f} MB | "
                    f"RAM: {mem_mb:.0f} MB")
                last_report_bytes = downloaded
                last_report_time  = time.time()

    published_path = _publish_staged_file(file_path, file_name)
    shutil.rmtree(staging_dir, ignore_errors=True)
    current_task["progress"] = 100
    current_task["status"]   = "completed"
    api.status_update(config, download_id, "completed", location_path=published_path)
    logger.log("info", f"HTTP download completed locally: {published_path} ({downloaded:,} bytes)")


def _cleanup_local_file(directory: str, file_name: str) -> None:
    path = os.path.join(directory, file_name)
    if os.path.exists(path):
        try:
            os.remove(path)
        except Exception:
            pass


# ── Torrent download ──────────────────────────────────────────────────────────

def process_torrent_download(config: WorkerConfig, task: dict, current_task: dict) -> None:
    download_id      = task["downloadId"]
    magnet_link      = task["sourceUrl"]
    file_name        = task.get("fileName") or ""
    file_indices_raw = task.get("fileIndices")

    # DB stores 0-based indices; aria2c --select-file is 1-based
    file_indices: Optional[list[int]] = None
    if file_indices_raw:
        try:
            parsed = (json.loads(file_indices_raw)
                      if isinstance(file_indices_raw, str)
                      else file_indices_raw)
            if isinstance(parsed, list) and parsed:
                file_indices = [i + 1 for i in parsed]
        except Exception as e:
            logger.log("warning", f"Could not parse fileIndices: {e}")

    display_name = _safe_file_name(file_name or "torrent", "torrent")
    logger.log("info", f"Torrent download via aria2c: {display_name} → {config.download_location}")

    current_task.update({
        "downloadId": download_id,
        "fileName":   display_name,
        "status":     "downloading",
        "progress":   0,
        "startedAt":  _now_iso(),
    })
    # Notify backend — DB status: pending → downloading
    api.status_update(config, download_id, "downloading")

    if not _ensure_aria2c():
        msg = "aria2c is not available. Run: !apt-get install -y aria2"
        logger.log("error", msg)
        current_task["status"] = "failed"
        api.status_update(config, download_id, "failed", msg)
        current_task.clear()
        return

    save_path = _partial_dir(download_id)
    _clean_stale_aria2_files(save_path)

    cmd = _build_aria2c_cmd(save_path, magnet_link, file_indices)
    logger.log("info", "aria2c started — waiting for peers...")

    total_bytes = downloaded_bytes = 0
    last_report_time  = time.time()
    downloaded_path: Optional[str] = None
    progress_re = re.compile(r'\[#\w+\s+([\d.]+\w+)/([\d.]+\w+)\((\d+)%\)')
    metadata_phase_logged = False
    payload_download_started = False

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

            if "Download complete:" in line:
                downloaded_path = line.split("Download complete:")[-1].strip()

            m = progress_re.search(line)
            if m:
                downloaded_bytes = _parse_size(m.group(1))
                total_bytes      = _parse_size(m.group(2))
                pct              = int(m.group(3))

                # aria2 may report its magnet metadata lookup as 100% even
                # though it has no payload size (0B/0B). Keep the worker at
                # 0% until it has discovered the selected torrent content.
                if total_bytes <= 0:
                    current_task["progress"] = 0
                    if not metadata_phase_logged:
                        logger.log("info", "Torrent metadata resolved — waiting for peers and file data")
                        metadata_phase_logged = True
                    continue

                if not payload_download_started:
                    payload_download_started = True
                    logger.log("info", f"Torrent payload download started ({total_bytes:,} bytes)")

                current_task["progress"] = pct

                now = time.time()
                if now - last_report_time >= 10:
                    mem_mb = psutil.virtual_memory().used / 1024 / 1024
                    logger.log("info",
                        f"📊 {pct}% | "
                        f"{downloaded_bytes/1024/1024:.1f} / {total_bytes/1024/1024:.1f} MB | "
                        f"RAM: {mem_mb:.0f} MB")
                    last_report_time = now

        process.wait()

        if process.returncode != 0:
            msg = f"aria2c exited with code {process.returncode}"
            logger.log("error", msg)
            current_task["status"] = "failed"
            api.status_update(config, download_id, "failed", msg)
            return

        logger.log("info", f"Torrent download finished in staging: {display_name}")

        if config.download_location == "mega":
            current_task["status"] = "uploading"
            files = _collect_downloaded_files(save_path, downloaded_path, display_name)
            success = _upload_torrent_files_to_mega(config, files, display_name,
                                                     download_id, total_bytes)
            if not success:
                return
        else:
            published = _publish_staged_tree(save_path)
            if not published:
                raise RuntimeError("aria2c completed without producing a local file")
            logger.log("info", f"Published {len(published)} torrent file(s) to {_downloads_dir()}")

        current_task["progress"] = 100
        current_task["status"]   = "completed"
        location_path = None
        if config.download_location == "local":
            location_path = published[0] if len(published) == 1 else _downloads_dir()
        api.status_update(config, download_id, "completed", location_path=location_path)
        logger.log("info", f"Torrent task completed: {display_name}")

    except Exception as e:
        logger.log("error", f"Torrent download failed: {e}")
        current_task["status"] = "failed"
        api.status_update(config, download_id, "failed", str(e))
    finally:
        shutil.rmtree(save_path, ignore_errors=True)
        current_task.clear()


def _upload_torrent_files_to_mega(
    config: WorkerConfig,
    files: list[str],
    display_name: str,
    download_id: str,
    total_bytes: int,
) -> bool:
    if not files:
        logger.log("warning", "Could not locate any downloaded files for Mega upload")
        return True  # not a fatal error — file may be local

    if len(files) == 1:
        ok = mega.upload_file_to_mega(config, files[0], os.path.basename(files[0]))
        if not ok:
            current_task_ref = None  # upload_torrent doesn't have direct ref, status set by caller
            api.status_update(config, download_id, "failed", "Mega upload failed — check logs")
        return ok

    ok = mega.upload_files_to_mega_folder(config, files, display_name)
    if not ok:
        api.status_update(config, download_id, "failed", "Mega folder upload failed — check logs")
    return ok


def _collect_downloaded_files(
    save_path: str,
    aria2c_reported_path: Optional[str],
    display_name: str,
) -> list[str]:
    def _files_in(path: str) -> list[str]:
        if not path or not os.path.exists(path):
            return []
        if os.path.isfile(path):
            return [path]
        result: list[str] = []
        for root, _, names in os.walk(path):
            for name in names:
                result.append(os.path.join(root, name))
        return sorted(result)

    if aria2c_reported_path:
        found = _files_in(aria2c_reported_path)
        if found:
            return found

    found = _files_in(os.path.join(save_path, display_name))
    if found:
        return found

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


def _build_aria2c_cmd(save_path: str, magnet_link: str, file_indices: Optional[list[int]]) -> list[str]:
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
    # --select-file MUST come before the magnet URI
    if file_indices:
        select_str = ",".join(str(i) for i in file_indices)
        cmd += ["--select-file", select_str]
        logger.log("info", f"Selecting files: {select_str}")
    cmd.append(magnet_link)
    return cmd


def _ensure_aria2c() -> bool:
    if shutil.which("aria2c"):
        return True
    logger.log("info", "aria2c not found — attempting install via apt-get...")
    try:
        subprocess.run(["apt-get", "install", "-y", "aria2"], check=True, capture_output=True)
        logger.log("info", "aria2c installed successfully")
        return shutil.which("aria2c") is not None
    except Exception as e:
        logger.log("error", f"Could not install aria2c: {e}")
        return False


def _clean_stale_aria2_files(directory: str) -> None:
    try:
        for entry in os.listdir(directory):
            if entry.endswith(".aria2"):
                path = os.path.join(directory, entry)
                os.remove(path)
                logger.log("info", f"Removed stale aria2c control file: {entry}")
    except Exception:
        pass


def _parse_size(s: str) -> int:
    units = {
        "B": 1,
        "KiB": 1024,    "MiB": 1024**2,  "GiB": 1024**3,  "TiB": 1024**4,
        "KB":  1000,    "MB":  1000**2,   "GB":  1000**3,   "TB":  1000**4,
    }
    m = re.match(r"([\d.]+)(\w+)", s)
    if not m:
        return 0
    val, unit = float(m.group(1)), m.group(2)
    return int(val * units.get(unit, 1))
