"""
Download handlers — HTTP and torrent.

Both paths download the payload to the worker's disk first, then either publish
it to the local downloads folder or upload it to Mega. There is no concurrent
download-while-uploading mode.

Each handler reports progress back to the backend and handles cleanup.
On completion or failure, calls api.status_update() to notify the Next.js backend.
Respects cancel flags set via the worker's DELETE /download/{id} endpoint.
"""

import json
import os
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

import psutil
import requests

from streamlift_worker import api, logger, mega
from streamlift_worker.config import WorkerConfig
from streamlift_worker.local_files import downloads_dir, record_completed_files

# Guards against the same download being started twice (e.g. a double dispatch
# from the frontend racing the pending → downloading status transition). The
# public process_* entry points refuse to run an id that is already in flight.
_active_download_ids: set[str] = set()
_active_download_lock = threading.Lock()


def _claim_download_run(download_id: str) -> bool:
    """Atomically mark a download_id as being processed. False if already so."""
    with _active_download_lock:
        if download_id in _active_download_ids:
            return False
        _active_download_ids.add(download_id)
        return True


def _release_download_run(download_id: str) -> None:
    """Drop a download_id from the in-flight set when its task finishes."""
    with _active_download_lock:
        _active_download_ids.discard(download_id)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _colab_dir() -> str:
    """Return /content in Colab, or cwd elsewhere."""
    return "/content" if os.path.exists("/content") else os.getcwd()


def _downloads_dir() -> str:
    """Return the user-visible local download directory, creating it if needed."""
    return downloads_dir()


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


def _publish_staged_files(staging_dir: str, files: list[str]) -> list[str]:
    """Publish only the selected files from a staged torrent."""
    published: list[str] = []
    for source in files:
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


def _make_upload_progress_callback(download_id: str, current_task: dict):
    """Build progress + stall callbacks for a Mega upload.

    The progress callback updates the live ``current_task`` (fed to the app via
    /status SSE) with the upload percentage and logs throttled 📤 lines, so a
    slow upload is never mistaken for a hang. It also aborts on cancel.
    """
    last = {"time": time.time(), "bytes": 0}

    def _progress(done: int, total: int) -> None:
        if _is_cancelled(download_id):
            raise mega.UploadCancelled("Cancelled by user")
        pct = round((done / total * 100), 2) if total else 0
        current_task["status"]   = "uploading"
        current_task["progress"] = pct
        now = time.time()
        if now - last["time"] >= 10 or done - last["bytes"] >= 5 * 1024 * 1024:
            mem_mb = psutil.virtual_memory().used / 1024 / 1024
            logger.log("info",
                f"📤 Upload {pct:.1f}% | "
                f"{done/1024/1024:.1f} / {total/1024/1024:.1f} MB | "
                f"RAM: {mem_mb:.0f} MB")
            last["time"] = now
            last["bytes"] = done

    def _stall(seconds: float) -> None:
        logger.log("warning", f"⚠️  Upload stalled {seconds}s waiting for Mega — still connected")

    return _progress, _stall


# ── HTTP download ─────────────────────────────────────────────────────────────

def process_http_download(config: WorkerConfig, task: dict, current_task: dict) -> None:
    download_id = task["downloadId"]
    if not _claim_download_run(download_id):
        logger.log(
            "warning",
            f"HTTP download already in progress, ignoring duplicate start: {download_id}",
        )
        return
    try:
        _process_http_download(config, task, current_task)
    finally:
        _release_download_run(download_id)


def _process_http_download(config: WorkerConfig, task: dict, current_task: dict) -> None:
    download_id = task["downloadId"]
    source_url  = task["sourceUrl"]
    file_name   = _safe_file_name(task.get("fileName") or "download")
    staging_dir = _partial_dir(download_id)

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

    resp: Optional[requests.Response] = None
    try:
        resp = requests.get(source_url, stream=True, timeout=30)
        resp.raise_for_status()
        total = int(resp.headers.get("content-length", 0))
        _ensure_disk_space(staging_dir, total)
        file_path = _http_download_to_disk(
            config, resp, total, download_id, file_name, current_task, staging_dir
        )
        if file_path is None:
            # Cancelled while downloading — the helper already reported failure.
            return

        if config.download_location == "mega":
            _upload_staged_file_to_mega(
                config, download_id, file_name, file_path, current_task
            )
        else:
            published_path = _publish_staged_file(file_path, file_name)
            record_completed_files(download_id, [published_path])
            current_task["progress"] = 100
            current_task["status"]   = "completed"
            api.status_update(config, download_id, "completed", location_path=published_path)
            logger.log(
                "info",
                f"HTTP download completed locally: {published_path} "
                f"({os.path.getsize(published_path):,} bytes)",
            )

    except mega.UploadCancelled:
        logger.log("info", "Mega upload cancelled by user")
        current_task["status"] = "failed"
        api.status_update(config, download_id, "failed", "Cancelled by user")
    except Exception as e:
        logger.log("error", f"HTTP download failed: {e}")
        api.status_update(config, download_id, "failed", str(e))
    finally:
        try:
            resp.close()
        except Exception:
            pass
        shutil.rmtree(staging_dir, ignore_errors=True)
        current_task.clear()


def _ensure_disk_space(directory: str, required: int) -> None:
    """Fail early with a clear message when the payload cannot fit on disk."""
    if required <= 0:
        return
    free = shutil.disk_usage(directory).free
    if free < required:
        raise RuntimeError(
            f"Not enough free disk space: need {required/1024/1024:.1f} MB, "
            f"have {free/1024/1024:.1f} MB"
        )


def _http_download_to_disk(
    config: WorkerConfig,
    resp: requests.Response,
    total: int,
    download_id: str,
    file_name: str,
    current_task: dict,
    staging_dir: str,
) -> Optional[str]:
    """Write the HTTP response body to the staging directory.

    Returns the staged file path, or ``None`` when the user cancelled. Raises
    on network/filesystem errors so the caller can report a failed download.
    """
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
                return None

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

    if total > 0 and downloaded != total:
        raise RuntimeError(
            f"Download incomplete: expected {total:,} bytes, got {downloaded:,}"
        )

    logger.log(
        "info",
        f"HTTP download finished on disk: {file_name} ({downloaded:,} bytes)",
    )
    return file_path


def _upload_staged_file_to_mega(
    config: WorkerConfig,
    download_id: str,
    file_name: str,
    file_path: str,
    current_task: dict,
) -> None:
    """Upload an already-downloaded file to Mega, then report the result."""
    total = os.path.getsize(file_path)
    current_task["status"]   = "uploading"
    current_task["progress"] = 0
    api.status_update(config, download_id, "uploading")
    logger.log("info", f"Uploading {file_name} to Mega ({total/1024/1024:.1f} MB)")

    progress_cb, stall_cb = _make_upload_progress_callback(download_id, current_task)
    handle = mega.upload_file_to_mega(
        config,
        file_path,
        file_name,
        progress_cb=progress_cb,
        progress_total=total,
        stall_cb=stall_cb,
    )

    if handle:
        current_task["progress"] = 100
        current_task["status"]   = "completed"
        mega.register_uploaded_node(download_id, handle)
        api.status_update(config, download_id, "completed", cloud_file_handle=handle)
        logger.log("info", f"HTTP download uploaded to Mega: {file_name}")
    else:
        current_task["status"] = "failed"
        api.status_update(config, download_id, "failed", "Mega upload failed — check logs")


# ── Torrent download ──────────────────────────────────────────────────────────

def process_torrent_download(config: WorkerConfig, task: dict, current_task: dict) -> None:
    download_id = task["downloadId"]
    if not _claim_download_run(download_id):
        logger.log(
            "warning",
            f"Torrent download already in progress, ignoring duplicate start: {download_id}",
        )
        return
    try:
        _process_torrent_download(config, task, current_task)
    finally:
        _release_download_run(download_id)


def _process_torrent_download(config: WorkerConfig, task: dict, current_task: dict) -> None:
    download_id      = task["downloadId"]
    magnet_link      = task["sourceUrl"]
    file_name        = task.get("fileName") or ""
    file_indices_raw = task.get("fileIndices")

    # DB stores 0-based indices; aria2c --select-file is 1-based
    file_indices_0: Optional[list[int]] = None
    if file_indices_raw:
        try:
            parsed = (json.loads(file_indices_raw)
                      if isinstance(file_indices_raw, str)
                      else file_indices_raw)
            if isinstance(parsed, list):
                coerced: list[int] = []
                for item in parsed:
                    if isinstance(item, bool):
                        continue
                    if isinstance(item, int):
                        if item >= 0:
                            coerced.append(item)
                    elif isinstance(item, str) and item.strip().isdigit():
                        coerced.append(int(item.strip()))
                file_indices_0 = coerced or None
                if parsed and file_indices_0 is None:
                    logger.log(
                        "warning",
                        f"fileIndices contained no usable non-negative integers: {parsed!r}",
                    )
        except Exception as e:
            logger.log("warning", f"Could not parse fileIndices: {e}")

    if file_indices_0 is None:
        logger.log("info", "No fileIndices supplied — downloading every torrent file")
    else:
        logger.log("info", f"fileIndices received: {file_indices_0}")

    file_indices: Optional[list[int]] = (
        [i + 1 for i in file_indices_0] if file_indices_0 else None
    )

    display_name = _safe_file_name(file_name or "torrent", "torrent")
    logger.log("info", f"Torrent download: {display_name} → {config.download_location}")

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
    max_total_bytes = 0
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

        cancelled = False
        for line in process.stdout:  # type: ignore[union-attr]
            line = line.rstrip()
            if line and logger.console_enabled():
                print(line, flush=True)

            if _is_cancelled(download_id):
                cancelled = True
                logger.log("info", f"Torrent download cancelled: {display_name}")
                process.terminate()
                break

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

                # Track max total_bytes seen — aria2 first reports metadata size
                # (~10-20KB), then discovers actual file size (much larger).
                # Only treat as "payload download" when total_bytes grows significantly.
                if total_bytes > max_total_bytes:
                    max_total_bytes = total_bytes

                # Wait until we've seen a substantial size jump (metadata -> payload)
                if not payload_download_started:
                    if max_total_bytes > 1024 * 1024:  # > 1MB indicates real content
                        payload_download_started = True
                        logger.log("info", f"Torrent payload download started ({max_total_bytes:,} bytes)")
                    else:
                        current_task["progress"] = 0
                        continue

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

        if cancelled:
            current_task["status"] = "failed"
            api.status_update(config, download_id, "failed", "Cancelled by user")
            return

        if process.returncode != 0:
            msg = f"aria2c exited with code {process.returncode}"
            logger.log("error", msg)
            current_task["status"] = "failed"
            api.status_update(config, download_id, "failed", msg)
            return

        logger.log("info", f"Torrent download finished in staging: {display_name}")

        # BitTorrent downloads whole pieces, so files that share a piece with
        # the selected file (typically the .srt or small extras next to the
        # video) are written to disk too. Keep only the paths the user actually
        # selected; otherwise those neighbours get uploaded and turn a
        # single-file download into a MEGA folder.
        torrent_path = _find_saved_torrent(save_path)
        selected_paths = _selected_relative_paths(torrent_path, file_indices_0)
        if torrent_path:
            try:
                os.remove(torrent_path)
            except OSError:
                pass

        staged_files = _collect_downloaded_files(save_path, downloaded_path, display_name)
        files = _filter_downloaded_files(staged_files, save_path, selected_paths)
        if selected_paths is not None and not files:
            raise RuntimeError(
                "Selected torrent file(s) were not found after download"
            )

        if config.download_location == "mega":
            current_task["status"]   = "uploading"
            current_task["progress"] = 0
            api.status_update(config, download_id, "uploading")
            progress_cb, stall_cb = _make_upload_progress_callback(download_id, current_task)
            try:
                upload_total = sum(os.path.getsize(f) for f in files if os.path.isfile(f))
            except OSError:
                upload_total = 0
            try:
                uploaded = _upload_torrent_files_to_mega(config, files, display_name,
                                                         download_id, upload_total,
                                                         progress_cb, stall_cb)
            except mega.UploadCancelled:
                logger.log("info", "Mega upload cancelled by user")
                current_task["status"] = "failed"
                api.status_update(config, download_id, "failed", "Cancelled by user")
                return
            if not uploaded:
                return
            cloud_handle = uploaded if isinstance(uploaded, str) else None
        else:
            published = _publish_staged_files(save_path, files)
            if not published:
                raise RuntimeError("aria2c completed without producing a local file")
            record_completed_files(download_id, published)
            logger.log("info", f"Published {len(published)} torrent file(s) to {_downloads_dir()}")
            cloud_handle = None

        current_task["progress"] = 100
        current_task["status"]   = "completed"
        location_path = None
        if config.download_location == "local":
            location_path = published[0] if len(published) == 1 else _downloads_dir()
        api.status_update(config, download_id, "completed", location_path=location_path,
                          cloud_file_handle=cloud_handle)
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
    upload_total: int,
    progress_cb,
    stall_cb,
) -> Any:
    if not files:
        logger.log("warning", "Could not locate any downloaded files for Mega upload")
        return True  # not a fatal error — file may be local

    if len(files) == 1:
        handle = mega.upload_file_to_mega(
            config, files[0], os.path.basename(files[0]),
            progress_cb=progress_cb, progress_total=upload_total, stall_cb=stall_cb,
        )
        if not handle:
            api.status_update(config, download_id, "failed", "Mega upload failed — check logs")
            return False
        mega.register_uploaded_node(download_id, handle)
        return handle

    ok = mega.upload_files_to_mega_folder(
        config, files, display_name,
        progress_cb=progress_cb, progress_total=upload_total, stall_cb=stall_cb,
    )
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
            return [] if path.endswith(".aria2") else [path]
        result: list[str] = []
        for root, _, names in os.walk(path):
            for name in names:
                if name.endswith(".aria2"):
                    continue
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


def _find_saved_torrent(save_path: str) -> Optional[str]:
    """Return the .torrent metadata aria2c saved for a magnet download."""
    try:
        candidates = [
            os.path.join(save_path, name)
            for name in os.listdir(save_path)
            if re.fullmatch(r"[0-9a-fA-F]{40,64}\.torrent", name)
            and os.path.isfile(os.path.join(save_path, name))
        ]
    except OSError:
        return None
    if not candidates:
        return None
    return max(candidates, key=os.path.getmtime)


def _selected_relative_paths(
    torrent_path: Optional[str],
    file_indices_0: Optional[list[int]],
) -> Optional[list[str]]:
    """Map the user's 0-based indices to paths inside the torrent.

    ``None`` means "no selection / could not resolve" and keeps the legacy
    upload-everything behaviour. An empty selection (all files) is also
    represented by ``None`` so callers do not filter.
    """
    if not file_indices_0:
        return None
    if not torrent_path:
        logger.log(
            "warning",
            "Torrent selection could not be resolved: no saved .torrent metadata; "
            "all staged files will be uploaded",
        )
        return None

    from streamlift_worker.torrent_metadata import _is_pad, _parse_torrent_meta

    try:
        _piece_len, meta_files = _parse_torrent_meta(torrent_path)
    except Exception as e:
        logger.log("warning", f"Could not parse saved torrent metadata: {e}")
        return None

    by_index = {idx: rel for idx, rel, _size, _offset in meta_files}
    selected: list[str] = []
    for idx in file_indices_0:
        rel = by_index.get(idx)
        if rel is None:
            logger.log("warning", f"Selected torrent index {idx} is absent from metadata")
            continue
        if _is_pad(rel):
            logger.log("warning", f"Ignoring pad file selected at index {idx}")
            continue
        selected.append(rel.replace("\\", "/"))

    if not selected:
        logger.log(
            "warning",
            "No valid selected file paths; all staged files will be uploaded",
        )
        return None

    preview = ", ".join(selected[:5])
    if len(selected) > 5:
        preview += f" … (+{len(selected) - 5})"
    logger.log("info", f"Torrent selection resolved ({len(selected)}): {preview}")
    return selected


def _filter_downloaded_files(
    files: list[str],
    save_path: str,
    selected_paths: Optional[list[str]],
) -> list[str]:
    """Keep staged files that belong to the user's torrent selection."""
    if selected_paths is None:
        return files

    selected = {path.strip("/") for path in selected_paths}
    kept: list[str] = []
    for path in files:
        relative = os.path.relpath(path, save_path).replace("\\", "/").lstrip("/")
        if any(
            relative == wanted or relative.endswith("/" + wanted)
            for wanted in selected
        ):
            kept.append(path)

    logger.log(
        "info",
        f"Torrent selection filter: {len(kept)} of {len(files)} staged file(s) "
        "will be uploaded",
    )
    return kept


def _build_aria2c_cmd(save_path: str, magnet_link: str, file_indices: Optional[list[int]]) -> list[str]:
    from streamlift_worker.torrent_metadata import _bt_tracker_map

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
        "--bt-save-metadata=true",
    ]
    tracker = _bt_tracker_map()
    if tracker:
        cmd += ["--bt-tracker", tracker]
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
    env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
    try:
        subprocess.run(
            ["apt-get", "install", "-y", "--no-install-recommends", "aria2"],
            check=True, capture_output=True, env=env,
        )
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
