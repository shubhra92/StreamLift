"""Safe manifest and lookup helpers for worker-local completed downloads."""

import json
import os
import tempfile
import threading
from typing import Any


_MANIFEST_NAME = ".streamlift-files.json"
_lock = threading.Lock()


def downloads_dir() -> str:
    root = "/content" if os.path.exists("/content") else os.getcwd()
    path = os.path.join(root, "streamlift-downloads")
    os.makedirs(path, exist_ok=True)
    return path


def record_completed_files(download_id: str, paths: list[str]) -> list[dict[str, Any]]:
    """Persist the completed files for a job as paths relative to downloads_dir."""
    root = os.path.realpath(downloads_dir())
    files: list[dict[str, Any]] = []

    for path in paths:
        resolved = os.path.realpath(path)
        if not _is_within(root, resolved) or not os.path.isfile(resolved):
            continue
        files.append({
            "path": os.path.relpath(resolved, root),
            "name": os.path.basename(resolved),
            "size": os.path.getsize(resolved),
        })

    with _lock:
        manifest = _read_manifest()
        manifest[download_id] = files
        _write_manifest(manifest)
    return files


def get_completed_files(download_id: str) -> list[dict[str, Any]]:
    """Return only manifest files that still safely exist on this worker."""
    root = os.path.realpath(downloads_dir())
    with _lock:
        entries = _read_manifest().get(download_id, [])

    available: list[dict[str, Any]] = []
    for index, entry in enumerate(entries):
        relative = entry.get("path") if isinstance(entry, dict) else None
        if not isinstance(relative, str):
            continue
        path = os.path.realpath(os.path.join(root, relative))
        if _is_within(root, path) and os.path.isfile(path):
            available.append({
                "index": index,
                "name": os.path.basename(path),
                "size": os.path.getsize(path),
            })
    return available


def resolve_completed_file(download_id: str, index: int) -> tuple[str, str] | None:
    """Resolve one manifest file by index, without exposing arbitrary paths."""
    root = os.path.realpath(downloads_dir())
    with _lock:
        entries = _read_manifest().get(download_id, [])

    if index < 0 or index >= len(entries):
        return None
    entry = entries[index]
    relative = entry.get("path") if isinstance(entry, dict) else None
    if not isinstance(relative, str):
        return None
    path = os.path.realpath(os.path.join(root, relative))
    if not _is_within(root, path) or not os.path.isfile(path):
        return None
    return path, os.path.basename(path)


def _manifest_path() -> str:
    return os.path.join(downloads_dir(), _MANIFEST_NAME)


def _read_manifest() -> dict[str, list[dict[str, Any]]]:
    try:
        with open(_manifest_path(), "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_manifest(manifest: dict[str, list[dict[str, Any]]]) -> None:
    directory = downloads_dir()
    fd, temp_path = tempfile.mkstemp(prefix=".streamlift-manifest-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, separators=(",", ":"))
        os.replace(temp_path, _manifest_path())
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def _is_within(root: str, path: str) -> bool:
    try:
        return os.path.commonpath([root, path]) == root
    except ValueError:
        return False
