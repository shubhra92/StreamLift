"""
Torrent metadata resolution (no payload download).

`POST /torrent-metadata` resolves a magnet link into the file list the
frontend shows before a download starts. Everything here is metadata-only:
aria2c fetches the .torrent, the bencoded payload is parsed in memory, and the
scratch directory is removed immediately.

Payload downloads (and the subsequent MEGA upload) live in ``downloader.py``.
"""

from __future__ import annotations

import glob
import math
import os
import re
import shutil
import subprocess
import tempfile
from typing import Optional

from streamlift_worker import logger


def _bt_tracker_map() -> str:
    """Comma-separated tracker URL(s) from STREAMLIFT_BT_TRACKER (or empty).

    Useful for private trackers and for deterministic peer discovery in
    self-hosted/local deployments.
    """
    return os.environ.get("STREAMLIFT_BT_TRACKER", "").strip()


# ── minimal bencode / torrent metadata ───────────────────────────────────────


def _bdecode(data: bytes, pos: int = 0):
    """Decode one bencoded value. Returns (value, next_pos)."""
    kind = data[pos : pos + 1]
    if kind == b"i":
        end = data.index(b"e", pos)
        return int(data[pos + 1 : end]), end + 1
    if kind == b"d":
        pos += 1
        result: dict = {}
        while data[pos : pos + 1] != b"e":
            key, pos = _bdecode(data, pos)
            value, pos = _bdecode(data, pos)
            result[key] = value
        return result, pos + 1
    if kind == b"l":
        pos += 1
        result = []
        while data[pos : pos + 1] != b"e":
            item, pos = _bdecode(data, pos)
            result.append(item)
        return result, pos + 1
    end = data.index(b":", pos)
    length = int(data[pos:end])
    start = end + 1
    return data[start : start + length], start + length


def _parse_torrent_meta(path: str) -> tuple[int, list[tuple[int, str, int, int]]]:
    """Read a .torrent file → (piece_length, [(index, rel_path, size, offset)])."""
    with open(path, "rb") as f:
        raw = f.read()
    meta, _ = _bdecode(raw)
    info = meta[b"info"]
    piece_len = int(info.get(b"piece length", 0))
    files: list[tuple[int, str, int, int]] = []
    if b"files" in info:
        offset = 0
        for entry in info[b"files"]:
            parts = [p.decode("utf-8", "replace") for p in entry[b"path"]]
            rel = "/".join(parts) if parts else "file"
            size = int(entry.get(b"length", 0))
            files.append((len(files), rel, size, offset))
            offset += size
    else:
        name = info.get(b"name", b"download").decode("utf-8", "replace")
        size = int(info.get(b"length", 0))
        files.append((0, name, size, 0))
    return piece_len, files


def _is_pad(rel_path: str) -> bool:
    return any(seg == ".pad" for seg in rel_path.replace("\\", "/").split("/"))


def _metadata_phase(
    scratch: str, magnet_link: str, tracker: str = ""
) -> Optional[str]:
    """Fetch torrent metadata only, then return the saved .torrent path."""
    cmd = [
        "aria2c",
        "--dir", scratch,
        "--bt-metadata-only=true",
        "--bt-save-metadata=true",
        "--seed-time=0",
        "--console-log-level=error",
    ]
    if tracker:
        cmd += ["--bt-tracker", tracker]
    cmd.append(magnet_link)
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=120)
    except Exception as e:
        logger.log("warning", f"aria2c metadata phase failed: {e}")
        return None
    if proc.returncode != 0:
        logger.log("warning", f"aria2c metadata phase exited {proc.returncode}")
        return None
    torrents = sorted(glob.glob(os.path.join(scratch, "*.torrent")))
    if not torrents:
        logger.log("warning", "aria2c metadata phase produced no .torrent file")
        return None
    return torrents[0]


def _info_hash_from_magnet(magnet_link: str) -> str:
    """Extract the info-hash hex from a magnet link (xt=urn:btih:...)."""
    m = re.search(r"[?&]xt=urn:btih:([a-fA-F0-9]{32,40})", magnet_link)
    return m.group(1).lower() if m else ""


def _format_bytes(num: int) -> str:
    if num <= 0:
        return "0 Bytes"
    sizes = ["Bytes", "KB", "MB", "GB", "TB"]
    i = min(int(math.log(num, 1024)), len(sizes) - 1)
    return f"{num / (1024 ** i):.2f} {sizes[i]}"


def _file_type(rel_path: str) -> str:
    """Classify a file by extension — mirrors the Express backend shape."""
    ext = rel_path.rsplit(".", 1)[-1].lower() if "." in rel_path else ""
    if ext in {"mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v"}:
        return "video"
    if ext in {"mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"}:
        return "audio"
    if ext in {"jpg", "jpeg", "png", "gif", "bmp", "svg", "webp"}:
        return "image"
    if ext in {"pdf", "doc", "docx", "txt", "rtf", "odt", "epub"}:
        return "document"
    if ext in {"zip", "rar", "7z", "tar", "gz", "bz2"}:
        return "archive"
    return "other"


def fetch_torrent_metadata(
    magnet_link: str, tracker: str = ""
) -> Optional[dict]:
    """Resolve a magnet link via aria2c and return the Express-shaped metadata.

    Returns a dict matching ``POST /api/torrent-download/metadata``'s
    ``data`` payload so the frontend can swap the provider transparently:
    ``{name, infoHash, totalSize, totalSizeFormatted, fileCount, files}``
    where each file is ``{index, name, path, size, sizeFormatted, type}``
    (files sorted by size desc). ``None`` when metadata can't be fetched.
    Raises ``RuntimeError`` when aria2c is missing and cannot be installed.
    """
    from streamlift_worker.downloader import _ensure_aria2c  # lazy: no import cycle

    if not _ensure_aria2c():
        raise RuntimeError("aria2c could not be installed")

    scratch = tempfile.mkdtemp(prefix="sl-meta-")
    try:
        torrent_path = _metadata_phase(scratch, magnet_link, tracker=tracker)
        if not torrent_path:
            return None
        _piece_len, meta_files = _parse_torrent_meta(torrent_path)
        with open(torrent_path, "rb") as f:
            raw = f.read()
        _meta, _ = _bdecode(raw)
        info = _meta[b"info"]
        name = info.get(b"name", b"download").decode("utf-8", "replace")
        files = [
            {
                "index": idx,
                "name": rel.rsplit("/", 1)[-1],
                "path": rel,
                "size": size,
                "sizeFormatted": _format_bytes(size),
                "type": _file_type(rel),
            }
            for idx, rel, size, _off in meta_files
            if not _is_pad(rel)
        ]
        files.sort(key=lambda f: f["size"], reverse=True)
        total = sum(f["size"] for f in files)
        logger.log("info", f"Torrent metadata resolved: {name} ({len(files)} files)")
        return {
            "name": name,
            "infoHash": _info_hash_from_magnet(magnet_link),
            "totalSize": total,
            "totalSizeFormatted": _format_bytes(total),
            "fileCount": len(files),
            "files": files,
        }
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
