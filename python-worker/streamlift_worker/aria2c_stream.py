"""
aria2c-backed torrent → MEGA streaming (Colab-safe, no libtorrent).

aria2c has no piece-level scheduling, so a strict "N pieces, then the next N"
window is impossible. Instead we exploit two things:

- ``--bt-prioritize-piece=head=N`` makes each file's first N bytes download
  before anything else, so the file *prefix* arrives in order.
- aria2's ``<file>.aria2`` control file (documented in the aria2 technical
  notes) contains a per-piece completion bitfield. We poll it, compute the
  longest fully-complete *contiguous prefix* of the selection, and push those
  bytes into a blocking queue that ``mega.stream_to_mega`` consumes — so
  downloading and uploading run concurrently.

Disk stays as the torrent lays it out: bytes below the pump's push offset are
never re-read, and the scratch directory is removed in full after the stream
completes. The push frontier only ever advances over *verified* pieces (from
the control-file bitfield, or the file's own extent when the control file is
gone), so no in-place truncation during streaming.

If libtorrent is installed it is NOT used here (that's the Colab-safe choice);
this module only ever shells out to aria2c. Returns False → the downloader
falls back to the classic download-then-upload aria2c path.
"""

from __future__ import annotations

import glob
import os
import queue
import shutil
import struct
import subprocess
import threading
import time
from typing import Any, Optional

from streamlift_worker import logger, mega
from streamlift_worker.config import WorkerConfig


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


def _bt_head_flag() -> str:
    """Return the --bt-prioritize-piece head= value (runtime configurable).

    Reads STREAMLIFT_BT_HEAD (e.g. "32M", "512M", "1G"); defaults to 256M so a
    large leading slice of a file streams live before the out-of-order tail.
    """
    head = os.environ.get("STREAMLIFT_BT_HEAD", "256M").strip()
    if not head:
        head = "256M"
    return f"head={head}"


def _bt_tracker_map() -> str:
    """Comma-separated tracker URL(s) from STREAMLIFT_BT_TRACKER (or empty).

    Useful for private trackers and for deterministic peer discovery in
    self-hosted/local deployments.
    """
    return os.environ.get("STREAMLIFT_BT_TRACKER", "").strip()


class _PieceStream:
    """File-like object yielding torrent bytes pushed by the pump thread.

    Implements ``read(n)`` so megapy's ``upload_stream`` can consume it. Reads
    are continuous across the whole selected byte range, so multiple files can
    be uploaded sequentially from the same stream object.
    """

    def __init__(self, max_chunks: int = 16) -> None:
        self._q: queue.Queue = queue.Queue(maxsize=max_chunks)
        self._stop = threading.Event()
        self._buf = bytearray()
        self._eof = False
        self.consumed = 0

    def _push(self, data: bytes) -> None:
        while not self._stop.is_set():
            try:
                self._q.put(data, timeout=1.0)
                return
            except queue.Full:
                continue

    def _finish(self) -> None:
        self._push(None)

    def _abort(self) -> None:
        self._stop.set()

    def read(self, n: int = -1) -> bytes:
        if n is None or n < 0:
            n = 1 << 30
        while len(self._buf) < n and not self._eof:
            if self._stop.is_set():
                break
            try:
                item = self._q.get(timeout=0.5)
            except queue.Empty:
                continue
            if item is None:
                self._eof = True
                break
            self._buf += item
        out = bytes(self._buf[:n])
        del self._buf[:n]
        self.consumed += len(out)
        return out

    def close(self) -> None:  # megapy may call close() on its wrapper
        if not self._eof:
            self._abort()


# ── aria2 .aria2 control file ────────────────────────────────────────────────


def _parse_aria2_control(path: str) -> tuple[int, int, bytes]:
    """Parse an aria2 control file.

    Format (see aria2 Technical Notes, *.aria2 Control File):
    VERSION(2) EXT(4) INFO-HASH-LEN(4) INFO-HASH(N) PIECE-LEN(4)
    TOTAL-LEN(8) UPLOAD-LEN(8) BITFIELD-LEN(4) BITFIELD(N) ... all big-endian.
    Bit i of the bitfield (MSB first) = piece i is complete.
    Returns (piece_length, total_length, bitfield).
    """
    with open(path, "rb") as f:
        data = f.read()

    def u16(off: int) -> int:
        return struct.unpack(">H", data[off : off + 2])[0]

    def u32(off: int) -> int:
        return struct.unpack(">I", data[off : off + 4])[0]

    def u64(off: int) -> int:
        return struct.unpack(">Q", data[off : off + 8])[0]

    pos = 0
    version = u16(pos)
    pos += 2
    if version != 1:
        raise ValueError(f"unsupported aria2 control version {version}")
    pos += 4  # EXT (info-hash-check flag etc.)
    info_len = u32(pos)
    pos += 4 + info_len
    piece_len = u32(pos)
    pos += 4
    total_len = u64(pos)
    pos += 8
    pos += 8  # upload length
    bitfield_len = u32(pos)
    pos += 4
    if piece_len <= 0 or bitfield_len > (total_len // piece_len + 1):
        raise ValueError("malformed aria2 control file")
    return piece_len, total_len, data[pos : pos + bitfield_len]


def _contiguous_complete_bytes(bitfield: bytes, piece_len: int, total_len: int) -> int:
    """Longest fully-complete byte prefix of a download (piece 0..k, no gaps)."""
    if total_len <= 0 or piece_len <= 0:
        return 0
    done = 0
    max_bits = len(bitfield) * 8
    for idx in range(max_bits):
        if not (bitfield[idx // 8] & (1 << (7 - (idx % 8)))):
            break
        done += piece_len
    return min(done, total_len)


def _bitfield_complete_bytes(bitfield: bytes, piece_len: int, total_len: int) -> int:
    """Total bytes across all fully-complete pieces (regardless of order)."""
    if total_len <= 0 or piece_len <= 0:
        return 0
    done = 0
    max_bits = len(bitfield) * 8
    for idx in range(max_bits):
        if bitfield[idx // 8] & (1 << (7 - (idx % 8))):
            done += piece_len
    return min(done, total_len)


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


def _select_files(
    meta_files: list[tuple[int, str, int, int]],
    file_indices: Optional[list[int]],
) -> list[tuple[int, str, int, int]]:
    """Select torrent files (0-based raw indices; pads excluded)."""
    by_index = {idx: (idx, rel, size, off) for idx, rel, size, off in meta_files}

    def keep(entry: tuple[int, str, int, int]) -> bool:
        return not _is_pad(entry[1])

    if file_indices:
        requested = [i for i in file_indices if i in by_index]
        if len(requested) == len(file_indices) and all(
            keep(by_index[i]) for i in requested
        ):
            return [by_index[i] for i in sorted(requested)]
    return [e for e in meta_files if keep(e)]


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


# ── pump: feed completed prefix bytes into the upload stream ─────────────────


def _pump_loop(
    proc: subprocess.Popen,
    scratch: str,
    selected: list[tuple[int, str, int, int]],
    stream: _PieceStream,
    piece_len: int,
    download_id: str,
    current_task: dict,
) -> None:
    sizes = {rel: size for _i, rel, size, _o in selected}
    pushed: dict[str, int] = {rel: 0 for rel in sizes}
    fds: dict[str, Any] = {rel: None for rel in sizes}
    last_log = time.time()
    last_advance = time.time()
    stall_logged = False
    ctrl_seen = False
    complete_logged = False
    PUSH_CHUNK = 4 * 1024 * 1024

    def _loc(rel: str) -> str:
        """Resolve a torrent-relative path under scratch.

        Multi-file torrents are written by aria2c under an extra info-name
        subdirectory; probe one level deep so we never need to hardcode that.
        """
        direct = os.path.join(scratch, rel)
        if os.path.exists(direct) or os.path.exists(direct + ".aria2"):
            return direct
        try:
            for sub in os.listdir(scratch):
                cand = os.path.join(scratch, sub, rel)
                if os.path.exists(cand) or os.path.exists(cand + ".aria2"):
                    return cand
        except OSError:
            pass
        return direct

    while True:
        if all(pushed[r] >= sizes[r] for r in sizes):
            return  # every byte pushed into the stream — uploader drains it

        if _is_cancelled(download_id):
            raise mega.UploadCancelled("Cancelled by user")

        rc = proc.poll() if proc is not None else None
        if rc is not None and rc != 0:
            raise RuntimeError(f"aria2c exited early (code {rc})")

        swarm_done = 0
        advanced = False
        for rel, size in ((r, sizes[r]) for r in sizes):
            if pushed[rel] >= size:
                swarm_done += size
                continue
            loc = _loc(rel)
            ctrl = loc + ".aria2"
            if os.path.exists(ctrl):
                ctrl_seen = True
                try:
                    plen, tlen, bitfield = _parse_aria2_control(ctrl)
                except Exception:
                    plen, tlen, bitfield = piece_len, size, b""
                frontier = _contiguous_complete_bytes(bitfield, plen, tlen)
                swarm_done += _bitfield_complete_bytes(bitfield, plen, tlen)
            else:
                frontier = size  # control file gone → download complete
                if ctrl_seen and not complete_logged:
                    logger.log(
                        "info",
                        f"✔ Download complete — pushing remaining "
                        f"{max(0, size - pushed[rel])/1024/1024:.1f} MB",
                    )
                    complete_logged = True
                swarm_done += size

            if frontier <= pushed[rel]:
                continue  # nothing new yet — keep waiting (in order)

            if fds[rel] is None:
                try:
                    fds[rel] = open(loc, "rb")
                except OSError:
                    fds[rel] = None
            if fds[rel] is None:
                continue

            while pushed[rel] < frontier:
                want = min(frontier - pushed[rel], PUSH_CHUNK)
                try:
                    chunk = os.pread(fds[rel].fileno(), want, pushed[rel])
                except OSError:
                    chunk = b""
                if not chunk:
                    break
                stream._push(chunk)
                pushed[rel] += len(chunk)
                advanced = True

        now = time.time()
        total = sum(sizes[r] for r in sizes)
        if advanced:
            last_advance = now
            stall_logged = False
        elif now - last_advance >= 30 and not stall_logged:
            done = sum(pushed[r] for r in sizes)
            pct = (done / total * 100) if total else 0
            swarm = min(swarm_done, total)
            swarm_pct = (swarm / total * 100) if total else 0
            logger.log(
                "warning",
                f"⚠️  Waiting for swarm past head — {done/1024/1024:.1f} / "
                f"{total/1024/1024:.1f} MB pushed ({pct:.1f}%)"
                f" — swarm {swarm_pct:.1f}% complete",
            )
            stall_logged = True
        if now - last_log >= 10:
            done = sum(pushed[r] for r in sizes)
            pct = (done / total * 100) if total else 0
            swarm = min(swarm_done, total)
            swarm_pct = (swarm / total * 100) if total else 0
            logger.log(
                "info",
                f"⬇️  Streaming {pct:.1f}% | "
                f"{done/1024/1024:.1f} / {total/1024/1024:.1f} MB pushed"
                f" — swarm {swarm_pct:.1f}% complete",
            )
            # Reflect the download phase in the live task state so the
            # dashboard bar animates while pieces stream in. The upload
            # callback owns progress once it starts (status == uploading).
            if current_task.get("status") != "uploading":
                current_task["status"] = "downloading"
                current_task["progress"] = round(pct, 2)
            last_log = now

        time.sleep(0.5)


def _post_upload_progress(config, download_id: str, pct: float, total_bytes: Optional[int]):
    """Fire-and-forget a status='uploading' progress post (never blocks the upload).

    Runs in a daemon thread so the megaupload read loop is never stalled by a
    slow backend round-trip. Failures are ignored here — the backend sync is a
    best-effort nicety; the authoritative terminal state still comes from
    ``api.status_update``.
    """

    def _run() -> None:
        try:
            from streamlift_worker import api  # lazy: keep top-level imports light
            api.progress_update(config, download_id, pct, total_bytes)
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True).start()


def _upload_progress_callback(config, download_id: str, current_task: dict, total_bytes: Optional[int] = None):
    """Return (progress_cb, stall_cb) driving the live current_task + logs.

    Pushes a throttled ``uploading`` status/progress post to the backend (every
    >=10s) so the download row reflects the upload phase in real time instead of
    staying ``downloading`` until the final ``status_update``.
    """
    last = {"time": time.time(), "bytes": 0, "post": time.time()}

    def _progress(done: int, total: int) -> None:
        if _is_cancelled(download_id):
            raise mega.UploadCancelled("Cancelled by user")
        pct = round((done / total * 100), 2) if total else 0
        current_task["status"] = "uploading"
        current_task["progress"] = pct
        now = time.time()
        if now - last["time"] >= 10 or done - last["bytes"] >= 5 * 1024 * 1024:
            logger.log(
                "info",
                f"📤 Upload {pct:.1f}% | {done/1024/1024:.1f} / {total/1024/1024:.1f} MB",
            )
            last["time"] = now
            last["bytes"] = done
        if now - last["post"] >= 10:
            last["post"] = now
            _post_upload_progress(config, download_id, pct, total_bytes or total)

    def _stall(seconds: float) -> None:
        logger.log("warning", f"⚠️  Upload stalled {seconds}s waiting for pieces — still connected")

    return _progress, _stall


# ── entry point ──────────────────────────────────────────────────────────────


def stream_torrent_to_mega(
    config: WorkerConfig,
    download_id: str,
    magnet_link: str,
    file_indices: Optional[list[int]],
    display_name: str,
    current_task: dict,
    tracker: Optional[str] = None,
) -> Any:
    """Stream an aria2c torrent download straight into MEGA (concurrently).

    *tracker* (optional) is a comma-separated list of tracker URLs used for
    peer discovery for both the metadata and streaming phases; falls back to
    the STREAMLIFT_BT_TRACKER env var. Returns the uploaded MEGA node id (a
    truthy string) for single-file torrents, ``True`` for multi-file, or ``False``
    on any fallback-worthy failure. Raises ``mega.UploadCancelled`` on user cancel.
    """
    # aria2c must exist before anything else: install it first so a fresh
    # Colab session streams on its very first torrent instead of falling back.
    from streamlift_worker.downloader import _ensure_aria2c  # lazy: no import cycle

    if not _ensure_aria2c():
        logger.log("warning", "aria2c unavailable — cannot stream; falling back")
        return False

    from streamlift_worker.local_files import downloads_dir

    scraper = _bt_tracker_map()
    if tracker:
        scraper = tracker

    scratch = os.path.join(downloads_dir(), f".stream-{download_id}-{time.strftime('%H%M%S')}")
    os.makedirs(scratch, exist_ok=True)

    proc: Optional[subprocess.Popen] = None
    pump_errors: list[Exception] = []
    try:
        torrent_file = _metadata_phase(scratch, magnet_link, tracker=scraper)
        if not torrent_file:
            return False

        piece_len, meta_files = _parse_torrent_meta(torrent_file)
        selected = _select_files(meta_files, file_indices)
        if not selected:
            logger.log("warning", "No files selected for torrent streaming")
            return False
        total_bytes = sum(size for _, _, size, _ in selected)
        if total_bytes <= 0:
            return False

        is_multi = len(selected) > 1
        dest: Optional[str] = None
        if is_multi:
            client = mega.get_mega_client(config)
            folder = client.create_folder(display_name)
            dest = folder.node_id
            logger.log("info", f"MEGA folder ready: {display_name} ({folder.node_id})")

        cmd = [
            "aria2c",
            "--dir", scratch,
            "--seed-time=0",
            "--continue=true",
            "--file-allocation=none",
            "--auto-file-renaming=false",
            "--allow-overwrite=true",
            "--bt-stop-timeout=300",
            "--console-log-level=error",
            "--auto-save-interval=1",
            "--bt-prioritize-piece", _bt_head_flag(),
        ]
        if scraper:
            cmd += ["--bt-tracker", scraper]
        raw_indices = [i for i, _, _, _ in selected]
        if raw_indices:
            select_str = ",".join(str(i + 1) for i in raw_indices)
            cmd += ["--select-file", select_str]
        cmd.append(torrent_file)
        logger.log(
            "info",
            f"aria2c streaming {len(selected)} file(s) ({total_bytes/1024/1024:.1f} MB) "
            f"→ MEGA with {_bt_head_flag()}",
        )

        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        stream = _PieceStream()

        def _pump_target() -> None:
            try:
                _pump_loop(
                    proc, scratch, selected, stream, piece_len, download_id, current_task
                )
            except mega.UploadCancelled:
                raise
            except Exception as e:
                pump_errors.append(e)
                stream._abort()

        pump = threading.Thread(target=_pump_target, daemon=True)
        pump.start()

        progress_cb, stall_cb = _upload_progress_callback(config, download_id, current_task, total_bytes)
        # Reflect the upload phase on the backend immediately, before the first
        # throttled tick fires.
        _post_upload_progress(config, download_id, 0.0, total_bytes)
        cum = 0
        uploaded_node_ids: list[str] = []
        try:
            for _i, rel, size, _off in selected:
                if size <= 0:
                    continue
                file_name = os.path.basename(rel.replace("\\", "/"))
                logger.log(
                    "info",
                    f"🚀 Streaming {file_name} ({size/1024/1024:.1f} MB) into MEGA...",
                )
                handle = mega.stream_to_mega(
                    config,
                    stream,
                    size,
                    file_name,
                    progress_cb=progress_cb,
                    progress_total=total_bytes,
                    progress_offset=cum,
                    stall_cb=stall_cb,
                    retry_session=False,
                    dest=dest,
                )
                if not handle:
                    raise RuntimeError(f"Upload failed for {file_name}")
                uploaded_node_ids.append(handle)
                mega.register_uploaded_node(download_id, handle)
                cum += size
        finally:
            stream._abort()
            pump.join(timeout=5)

        if pump_errors:
            raise pump_errors[0]

        logger.log("info", f"🎉 All {len(selected)} file(s) streamed to MEGA: {display_name}")
        # Single-file uploads return the MEGA node id so the downloader can
        # report cloudFileHandle (→ share-link + download icons). Multi-file
        # torrents keep the legacy truthy return — folder-share UX is out of
        # scope.
        if len(uploaded_node_ids) == 1 and len(selected) == 1:
            return uploaded_node_ids[0]
        return True

    except mega.UploadCancelled:
        raise
    except Exception as e:
        logger.log("error", f"aria2c torrent streaming failed: {e}")
        return False
    finally:
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        shutil.rmtree(scratch, ignore_errors=True)