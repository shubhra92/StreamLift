"""Full pre-rendered HLS renditions for the Watch page.

The normal Watch path transcodes segments on demand while a player is watching.
That keeps CPU busy for the whole session and stalls whenever the encoder cannot
stay ahead of the playhead. A *pre-render* is the opposite: the whole file is
encoded once, in the background, into complete HLS media playlists and segments
stored on the worker disk. Playback then only serves files.

Storage layout (under ``<downloads>/.renders``)::

    <download_id>/<file_index>/<signature>/
        manifest.json
        audio/aud_<track>_00000.ts ...
        <quality>/seg_00000.ts ...
        <quality>...

The signature is the source file's ``(mtime_ns, size)`` hash. A re-downloaded
or edited source gets a new directory, so stale renders can never be served for
different bytes. Renders survive a graceful worker restart (unlike the
on-demand playback workspace) but, like the source files themselves, they do
not survive the worker VM/session ending.
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import quote

from streamlift_worker import logger
from streamlift_worker import streaming
from streamlift_worker.config import (
    HLS_AUDIO_BITRATE,
    HLS_BATCH_SEGMENTS,
    HLS_SEGMENT_TIMEOUT,
    RENDER_BUSY_RETRIES,
    RENDER_DISK_HEADROOM,
    RENDER_POLL_SECONDS,
    RENDERS_DIR_NAME,
)
from streamlift_worker.local_files import downloads_dir, resolve_completed_file

STATE_QUEUED = "queued"
STATE_RENDERING = "rendering"
STATE_READY = "ready"
STATE_FAILED = "failed"
STATE_CANCELED = "canceled"

_MANIFEST_NAME = "manifest.json"
_SEGMENT_RE = re.compile(r"^seg_(\d{5})\.ts$")
_AUDIO_SEGMENT_RE = re.compile(r"^aud_(\d+)_(\d{5})\.ts$")


class RenderError(Exception):
    """A render could not be completed."""


class RenderCanceled(Exception):
    """The user canceled this render."""


@dataclass
class RenderJob:
    download_id: str
    file_index: int
    quality: str
    signature_key: str
    duration: float = 0.0
    state: str = STATE_QUEUED
    progress: float = 0.0
    speed: Optional[float] = None
    bytes: int = 0
    detail: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    cancel: threading.Event = field(default_factory=threading.Event)

    @property
    def key(self) -> tuple[str, int, str, str]:
        return (
            self.download_id,
            int(self.file_index),
            self.signature_key,
            self.quality,
        )


# One render encoder at a time. Downloads and live playback keep priority: the
# render driver also waits for a slot in the shared playback semaphore.
_queue: "queue.Queue[Optional[RenderJob]]" = queue.Queue()
_jobs: dict[tuple[str, int, str, str], RenderJob] = {}
_lock = threading.RLock()
_dispatcher_started = False
_shutting_down = False


# ── Paths and manifests ───────────────────────────────────────────────────────


def renders_root() -> str:
    path = os.path.join(downloads_dir(), RENDERS_DIR_NAME)
    os.makedirs(path, exist_ok=True)
    return path


def _signature_key(signature: tuple[int, int]) -> str:
    return f"{signature[0]:x}-{signature[1]:x}"


def _render_root(download_id: str, file_index: int, signature_key: str) -> str:
    return os.path.join(renders_root(), download_id, str(int(file_index)), signature_key)


def _manifest_path(root: str) -> str:
    return os.path.join(root, _MANIFEST_NAME)


def _current_source(
    download_id: str, file_index: int
) -> Optional[tuple[str, tuple[int, int], str]]:
    resolved = resolve_completed_file(download_id, int(file_index))
    if not resolved:
        return None
    source = resolved[0]
    signature = streaming.render_signature(source)
    if signature is None:
        return None
    return source, signature, _signature_key(signature)


def _load_manifest(root: str) -> Optional[dict]:
    try:
        with open(_manifest_path(root), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _write_manifest(root: str, manifest: dict) -> None:
    os.makedirs(root, exist_ok=True)
    temporary = os.path.join(
        root, f".manifest.{os.getpid()}.{threading.get_ident()}.tmp"
    )
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, separators=(",", ":"))
        os.replace(temporary, _manifest_path(root))
    finally:
        if os.path.exists(temporary):
            try:
                os.remove(temporary)
            except OSError:
                pass


def _quality_dir(root: str, quality: str) -> str:
    return os.path.join(root, quality)


def _audio_dir(root: str) -> str:
    return os.path.join(root, "audio")


def _quality_entry(root: str, quality: str) -> Optional[dict]:
    manifest = _load_manifest(root)
    if not manifest:
        return None
    entry = (manifest.get("qualities") or {}).get(quality)
    return entry if isinstance(entry, dict) else None


def _audio_ready(root: str, manifest: Optional[dict] = None) -> bool:
    manifest = manifest or _load_manifest(root)
    if not manifest or not manifest.get("audioReady"):
        return False
    lengths = manifest.get("audioSegmentLengths") or []
    tracks = manifest.get("audio") or []
    if not tracks:
        return True
    directory = _audio_dir(root)
    if not os.path.isdir(directory):
        return False
    last = max(0, len(lengths) - 1)
    for track in tracks:
        ordinal = int(track.get("ordinal") or 0)
        path = os.path.join(directory, f"aud_{ordinal}_{last:05d}.ts")
        if not os.path.isfile(path) or os.path.getsize(path) <= 0:
            return False
    return True


def _quality_ready(root: str, quality: str) -> bool:
    entry = _quality_entry(root, quality)
    if not entry:
        return False
    lengths = entry.get("segmentLengths") or []
    directory = _quality_dir(root, quality)
    if not os.path.isdir(directory):
        return False
    last = max(0, len(lengths) - 1)
    path = os.path.join(directory, f"seg_{last:05d}.ts")
    return os.path.isfile(path) and os.path.getsize(path) > 0


def is_render_path(path: str) -> bool:
    """True when a served file belongs to the render store."""
    if not path:
        return False
    try:
        root = os.path.realpath(renders_root())
        return os.path.realpath(path).startswith(root + os.sep)
    except OSError:
        return False


# ── Public readiness queries ─────────────────────────────────────────────────


def ready_qualities(download_id: str, file_index: int) -> list[str]:
    """Quality ids that are fully rendered for the current source bytes."""
    current = _current_source(download_id, file_index)
    if not current:
        return []
    _source, _signature, signature_key = current
    root = _render_root(download_id, file_index, signature_key)
    manifest = _load_manifest(root)
    if not manifest:
        return []
    return [
        quality
        for quality in (manifest.get("qualities") or {})
        if _quality_ready(root, quality)
    ]


def summary(download_ids: list[str]) -> dict[str, dict[int, list[str]]]:
    """Cheap per-worker summary used to badge the watch list."""
    result: dict[str, dict[int, list[str]]] = {}
    root = renders_root()
    for download_id in download_ids:
        download_dir = os.path.join(root, download_id)
        if not os.path.isdir(download_dir):
            continue
        for index_name in os.listdir(download_dir):
            if not index_name.isdigit():
                continue
            index_dir = os.path.join(download_dir, index_name)
            if not os.path.isdir(index_dir):
                continue
            for signature_key in os.listdir(index_dir):
                manifest = _load_manifest(os.path.join(index_dir, signature_key))
                if not manifest:
                    continue
                ready = [
                    quality
                    for quality in (manifest.get("qualities") or {})
                    if _quality_ready(
                        os.path.join(index_dir, signature_key), quality
                    )
                ]
                if ready:
                    result.setdefault(download_id, {})[int(index_name)] = ready
    return result


# ── Playlists / segment resolution ───────────────────────────────────────────


def master_playlist(download_id: str, file_index: int) -> Optional[str]:
    """Master playlist listing only the qualities that are fully rendered."""
    current = _current_source(download_id, file_index)
    if not current:
        return None
    _source, _signature, signature_key = current
    root = _render_root(download_id, file_index, signature_key)
    manifest = _load_manifest(root)
    if not manifest:
        return None

    qualities = {
        quality: entry
        for quality, entry in (manifest.get("qualities") or {}).items()
        if isinstance(entry, dict) and _quality_ready(root, quality)
    }
    if not qualities:
        return None

    audio_tracks = manifest.get("audio") or []
    if audio_tracks and not _audio_ready(root, manifest):
        return None

    lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-INDEPENDENT-SEGMENTS"]
    default_ordinal = next(
        (i for i, track in enumerate(audio_tracks) if track.get("default")), 0
    )
    names: set[str] = set()
    for ordinal, track in enumerate(audio_tracks):
        name = _audio_label(track, ordinal)
        if name in names:
            name = f"{name} ({ordinal + 1})"
        names.add(name)
        attrs = [
            "TYPE=AUDIO",
            'GROUP-ID="aud"',
            f'NAME="{name}"',
            f'DEFAULT={"YES" if ordinal == default_ordinal else "NO"}',
            "AUTOSELECT=YES",
        ]
        if track.get("language"):
            attrs.append(f'LANGUAGE="{_hls_text(track.get("language"))}"')
        attrs.append('CHANNELS="2"')
        attrs.append(f'URI="audio/{ordinal}.m3u8"')
        lines.append("#EXT-X-MEDIA:" + ",".join(attrs))

    audio_attr = ',AUDIO="aud"' if audio_tracks else ""
    for quality, entry in qualities.items():
        height = int(entry.get("height") or 0)
        width = int(entry.get("width") or 0)
        resolution = f",RESOLUTION={width}x{height}" if width and height else ""
        bitrate = int(entry.get("bitrate") or 0) or 1
        label = _hls_text(entry.get("label") or f"{height}p")
        lines.append(
            f"#EXT-X-STREAM-INF:BANDWIDTH={bitrate}{resolution}"
            f',NAME="{label}"{audio_attr},CLOSED-CAPTIONS=NONE'
        )
        lines.append(f"video.m3u8?q={quote(quality, safe='')}")
    return "\n".join(lines) + "\n"


def video_playlist(
    download_id: str, file_index: int, quality: str
) -> Optional[str]:
    """One rendered video rendition, served from disk."""
    current = _current_source(download_id, file_index)
    if not current:
        return None
    _source, _signature, signature_key = current
    root = _render_root(download_id, file_index, signature_key)
    entry = _quality_entry(root, quality)
    if not entry or not _quality_ready(root, quality):
        return None
    lengths = entry.get("segmentLengths") or []
    if not lengths:
        return None
    quality_query = quote(quality, safe="")
    return streaming.playlist_for_render(
        [float(value) for value in lengths],
        lambda index: f"seg_{index:05d}.ts?q={quality_query}",
    )


def audio_playlist(
    download_id: str, file_index: int, track: int
) -> Optional[str]:
    """One rendered audio rendition, served from disk."""
    current = _current_source(download_id, file_index)
    if not current:
        return None
    _source, _signature, signature_key = current
    root = _render_root(download_id, file_index, signature_key)
    manifest = _load_manifest(root)
    if not manifest or not _audio_ready(root, manifest):
        return None
    tracks = manifest.get("audio") or []
    if track < 0 or track >= len(tracks):
        return None
    lengths = manifest.get("audioSegmentLengths") or []
    if not lengths:
        return None
    return streaming.playlist_for_render(
        [float(value) for value in lengths],
        lambda index: f"../aud_{track}_{index:05d}.ts",
    )


def segment_path(
    download_id: str,
    file_index: int,
    segment: str,
    quality: Optional[str],
) -> Optional[str]:
    """Resolve one rendered segment, or None when it is not rendered."""
    audio_match = _AUDIO_SEGMENT_RE.match(segment)
    video_match = _SEGMENT_RE.match(segment)
    if not audio_match and not video_match:
        return None

    current = _current_source(download_id, file_index)
    if not current:
        return None
    _source, _signature, signature_key = current
    root = _render_root(download_id, file_index, signature_key)

    if audio_match:
        manifest = _load_manifest(root)
        if not manifest or not _audio_ready(root, manifest):
            return None
        track = int(audio_match.group(1))
        index = int(audio_match.group(2))
        tracks = manifest.get("audio") or []
        lengths = manifest.get("audioSegmentLengths") or []
        if track < 0 or track >= len(tracks) or index >= len(lengths):
            return None
        path = os.path.join(_audio_dir(root), f"aud_{track}_{index:05d}.ts")
    else:
        if not quality:
            return None
        entry = _quality_entry(root, quality)
        if not entry or not _quality_ready(root, quality):
            return None
        index = int(video_match.group(1))
        lengths = entry.get("segmentLengths") or []
        if index >= len(lengths):
            return None
        path = os.path.join(_quality_dir(root, quality), f"seg_{index:05d}.ts")

    if os.path.isfile(path) and os.path.getsize(path) > 0:
        return path
    return None


# ── Render options / job API ─────────────────────────────────────────────────


def _job_for(
    download_id: str, file_index: int, signature_key: str, quality: str
) -> Optional[RenderJob]:
    with _lock:
        return _jobs.get(
            (download_id, int(file_index), signature_key, quality)
        )


def _job_payload(job: Optional[RenderJob]) -> Optional[dict]:
    if job is None:
        return None
    eta = None
    if (
        job.state == STATE_RENDERING
        and job.speed
        and job.duration > 0
        and job.progress < 1
    ):
        eta = max(0.0, (1.0 - job.progress) * job.duration / job.speed)
    return {
        "quality": job.quality,
        "state": job.state,
        "progress": round(job.progress, 4),
        "speed": round(job.speed, 3) if job.speed else None,
        "etaSeconds": round(eta, 1) if eta is not None else None,
        "bytes": int(job.bytes),
        "detail": job.detail,
    }


def _estimate_bytes(
    info,
    variant: dict,
    duration: float,
    source_size: int,
    audio_tracks: int,
) -> int:
    if variant.get("copy"):
        return int(source_size)
    bitrate = int(variant.get("bitrate") or 4_000_000)
    audio_bps = 128_000 * max(1, audio_tracks)
    return int((bitrate + audio_bps) * duration / 8)


def _options_locked(
    download_id: str, file_index: int, source: str, info, signature_key: str
) -> dict:
    root = _render_root(download_id, file_index, signature_key)
    manifest = _load_manifest(root) or {}
    duration = float(info.duration or 0.0)
    source_size = 0
    try:
        source_size = os.path.getsize(source)
    except OSError:
        pass

    variants = streaming.render_options(info)
    qualities: list[dict] = []
    rendered_bytes = 0
    active = False
    for variant in variants:
        quality = str(variant["quality"])
        entry = (manifest.get("qualities") or {}).get(quality)
        rendered = bool(entry) and _quality_ready(root, quality)
        if rendered and isinstance(entry, dict):
            rendered_bytes += int(entry.get("bytes") or 0)
        estimated = (
            source_size
            if variant.get("copy")
            else _estimate_bytes(
                info, variant, duration, source_size, len(info.audio_streams)
            )
        )
        job = _job_for(download_id, file_index, signature_key, quality)
        if job is not None and job.state in (STATE_QUEUED, STATE_RENDERING):
            active = True
        qualities.append(
            {
                "id": quality,
                "label": str(variant.get("name") or f"{variant.get('height')}p"),
                "height": int(variant["height"]) if variant.get("height") else None,
                "copy": bool(variant.get("copy")),
                "bitrate": int(variant.get("bitrate") or 0) or None,
                "estimatedBytes": int(estimated),
                "rendered": rendered,
                "job": _job_payload(job),
            }
        )

    try:
        free = shutil.disk_usage(downloads_dir()).free
    except OSError:
        free = None

    return {
        "success": True,
        "qualities": qualities,
        "renderedBytes": rendered_bytes,
        "freeBytes": free,
        "active": active,
    }


def options(download_id: str, file_index: int) -> Optional[dict]:
    """Quality ladder, render state and estimates for one watch item."""
    current = _current_source(download_id, file_index)
    if not current:
        return None
    source, _signature, signature_key = current
    info = streaming.probe_source(source)
    if info is None or not info.has_video or not info.duration:
        return None
    with _lock:
        return _options_locked(download_id, file_index, source, info, signature_key)


def start(
    download_id: str,
    file_index: int,
    qualities: list[str],
) -> dict:
    """Queue one or more quality renders for a file. Idempotent."""
    current = _current_source(download_id, file_index)
    if not current:
        raise RenderError("This file is no longer available on the worker")
    source, _signature, signature_key = current
    info = streaming.probe_source(source)
    if info is None or not info.has_video or not info.duration:
        raise RenderError("This file cannot be pre-rendered")

    variants = {
        str(variant["quality"]): variant
        for variant in streaming.render_options(info)
    }
    wanted: list[str] = []
    for raw in qualities:
        quality = str(raw).strip()
        if quality in variants and quality not in wanted:
            wanted.append(quality)
    if not wanted:
        raise RenderError("Choose at least one available quality")

    root = _render_root(download_id, file_index, signature_key)
    manifest = _load_manifest(root) or {}

    queued: list[RenderJob] = []
    estimated_total = 0
    with _lock:
        for quality in wanted:
            entry = (manifest.get("qualities") or {}).get(quality)
            if entry and _quality_ready(root, quality):
                continue
            key = (download_id, int(file_index), signature_key, quality)
            existing = _jobs.get(key)
            if existing is not None and existing.state in (
                STATE_QUEUED,
                STATE_RENDERING,
            ):
                continue
            variant = variants[quality]
            estimated_total += (
                os.path.getsize(source)
                if variant.get("copy")
                else _estimate_bytes(
                    info,
                    variant,
                    float(info.duration or 0),
                    os.path.getsize(source),
                    len(info.audio_streams),
                )
            )
            job = RenderJob(
                download_id=download_id,
                file_index=int(file_index),
                quality=quality,
                signature_key=signature_key,
                duration=float(info.duration or 0),
            )
            _jobs[key] = job
            queued.append(job)

        if queued:
            try:
                free = shutil.disk_usage(downloads_dir()).free
            except OSError:
                free = None
            if (
                free is not None
                and estimated_total > 0
                and free < estimated_total * RENDER_DISK_HEADROOM
            ):
                for job in queued:
                    _jobs.pop(job.key, None)
                raise RenderError(
                    "Not enough free space on the worker for this pre-render"
                )
            for job in queued:
                _queue.put(job)
            _ensure_dispatcher()

    logger.log(
        "info",
        f"Queued pre-render {', '.join(job.quality for job in queued)} for "
        f"{os.path.basename(source)}",
    )
    return options(download_id, file_index) or {"success": True, "qualities": []}


def cancel(download_id: str, file_index: int, quality: str) -> dict:
    current = _current_source(download_id, file_index)
    if not current:
        raise RenderError("This file is no longer available on the worker")
    _source, _signature, signature_key = current
    with _lock:
        job = _jobs.get((download_id, int(file_index), signature_key, quality))
        if job is not None:
            job.cancel.set()
            if job.state == STATE_QUEUED:
                job.state = STATE_CANCELED
                job.detail = "Canceled"
                job.completed_at = time.time()
    return options(download_id, file_index) or {"success": True, "qualities": []}


def delete(download_id: str, file_index: int, quality: str) -> dict:
    current = _current_source(download_id, file_index)
    if not current:
        raise RenderError("This file is no longer available on the worker")
    _source, _signature, signature_key = current
    root = _render_root(download_id, file_index, signature_key)

    with _lock:
        active = [
            job
            for job in _jobs.values()
            if job.download_id == download_id
            and job.file_index == int(file_index)
            and job.signature_key == signature_key
            and job.state in (STATE_QUEUED, STATE_RENDERING)
        ]
        if active:
            # Deleting the last completed quality removes the shared audio and
            # manifest while a sibling render is still writing them.
            raise RenderError("Wait for the running pre-render to finish")

    shutil.rmtree(_quality_dir(root, quality), ignore_errors=True)
    with _lock:
        manifest = _load_manifest(root)
        if manifest:
            qualities = manifest.get("qualities") or {}
            qualities.pop(quality, None)
            manifest["qualities"] = qualities
            manifest["updatedAt"] = time.time()
            if qualities:
                _write_manifest(root, manifest)
            else:
                shutil.rmtree(root, ignore_errors=True)
        _jobs.pop((download_id, int(file_index), signature_key, quality), None)

    logger.log(
        "info",
        f"Deleted pre-render {quality} for file {file_index} of {download_id}",
    )
    return options(download_id, file_index) or {"success": True, "qualities": []}


# ── Render execution ─────────────────────────────────────────────────────────


def _ensure_dispatcher() -> None:
    global _dispatcher_started
    with _lock:
        if _dispatcher_started or _shutting_down:
            return
        _dispatcher_started = True
    threading.Thread(
        target=_dispatch_loop, daemon=True, name="render-dispatch"
    ).start()


def _dispatch_loop() -> None:
    while True:
        job = _queue.get()
        if job is None:
            return
        if job.cancel.is_set():
            job.state = STATE_CANCELED
            job.detail = "Canceled"
            job.completed_at = time.time()
            continue
        try:
            _run_job(job)
        except RenderCanceled:
            job.state = STATE_CANCELED
            job.detail = "Canceled"
            job.completed_at = time.time()
            job.progress = 0.0
            logger.log(
                "info",
                f"Pre-render {job.quality} canceled for {os.path.basename(job.download_id)}",
            )
        except Exception as exc:  # pragma: no cover - defensive worker loop
            job.state = STATE_FAILED
            job.detail = str(exc) or "Pre-render failed"
            job.completed_at = time.time()
            logger.log(
                "warning",
                f"Pre-render {job.quality} failed for "
                f"{job.download_id}/{job.file_index}: {job.detail}",
            )


def _check_canceled(job: RenderJob) -> None:
    if job.cancel.is_set():
        raise RenderCanceled()


def _dir_segment_bytes(directory: str) -> int:
    total = 0
    try:
        for name in os.listdir(directory):
            if _SEGMENT_RE.match(name):
                try:
                    total += os.path.getsize(os.path.join(directory, name))
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _drive_video(job: RenderJob, session) -> None:
    """Encode every batch of a quality rendition, then verify all segments."""
    total = session.segment_count
    if total <= 0:
        raise RenderError("The source has no playable segments")
    step = max(1, int(HLS_BATCH_SEGMENTS))

    for first in range(0, total, step):
        end = min(first + step, total)
        _check_canceled(job)

        attempts = 0
        while True:
            if streaming._ensure_batch(
                session,
                first,
                wait=float(HLS_SEGMENT_TIMEOUT),
                limit=end - first,
            ):
                break
            attempts += 1
            if attempts >= RENDER_BUSY_RETRIES:
                raise RenderError(
                    "The worker is busy with playback; try the pre-render again later"
                )
            time.sleep(5.0)

        with session.condition:
            batch = session.batch
        if batch is not None:
            while batch.process.poll() is None:
                _check_canceled(job)
                job.speed = session.speed
                job.progress = 0.85 * min(1.0, len(session.completed) / total)
                job.bytes = _dir_segment_bytes(session.output_dir)
                time.sleep(RENDER_POLL_SECONDS)
            if batch.thread is not None:
                batch.thread.join(timeout=30)

        # A stream-copy batch can reject a segment that is not a clean IDR or
        # has a timestamp hole. Regenerate exactly those with a one-off encode.
        for index in range(first, end):
            _check_canceled(job)
            if not streaming._segment_ok(session, index):
                streaming._generate_video_fallback_segment(session, index)

        missing = [
            index
            for index in range(first, end)
            if not streaming._segment_ok(session, index)
        ]
        if missing:
            raise RenderError(
                f"Could not produce {len(missing)} playback segment"
                + ("s" if len(missing) != 1 else "")
            )

        job.progress = 0.85 * (end / total)
        job.bytes = _dir_segment_bytes(session.output_dir)

    job.progress = 0.85


def _audio_command(
    source: str,
    stream_index: int,
    output_dir: str,
    lengths: list[float],
    ordinal: int,
) -> list[str]:
    command = [
        "ffmpeg", "-hide_banner", "-nostdin", "-y",
        "-i", source,
        "-map", f"0:{stream_index}",
        "-vn", "-sn", "-dn",
        "-c:a", "aac", "-b:a", HLS_AUDIO_BITRATE, "-ac", "2",
        "-af", "asetpts=PTS-STARTPTS",
        "-muxdelay", "0", "-muxpreload", "0",
        "-f", "segment",
        "-segment_format", "mpegts",
        "-reset_timestamps", "0",
        "-segment_start_number", "0",
    ]
    # Audio has no keyframes: cut exactly on the shared segment grid so the
    # rendered audio matches every quality's fixed-length segments.
    boundaries: list[str] = []
    cursor = 0.0
    for length in lengths[:-1]:
        cursor += float(length)
        boundaries.append(f"{cursor:.6f}")
    if boundaries:
        command += ["-segment_times", ",".join(boundaries)]
    command.append(os.path.join(output_dir, f"aud_{ordinal}_%05d.ts"))
    return command


def _render_audio_track(
    job: RenderJob,
    source: str,
    info,
    track,
    ordinal: int,
    output_dir: str,
    lengths: list[float],
) -> None:
    log_path = os.path.join(output_dir, f"audio_{ordinal}.log")
    command = _audio_command(source, track.index, output_dir, lengths, ordinal)
    timeout = max(600.0, sum(lengths) * 2.0)
    try:
        with open(log_path, "wb") as log_handle:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
            )
            deadline = time.monotonic() + timeout
            while process.poll() is None:
                if job.cancel.is_set():
                    process.kill()
                    process.wait()
                    raise RenderCanceled()
                if time.monotonic() > deadline:
                    process.kill()
                    process.wait()
                    raise RenderError("Audio pre-render timed out")
                time.sleep(RENDER_POLL_SECONDS)
            returncode = process.returncode
    except OSError as exc:
        raise RenderError(f"Could not start the audio encoder: {exc}") from exc

    files = sorted(
        name
        for name in os.listdir(output_dir)
        if name.startswith(f"aud_{ordinal}_") and name.endswith(".ts")
    )
    if returncode != 0 or len(files) < len(lengths):
        raise RenderError(
            "Audio pre-render failed"
            + (f" ({_tail(log_path)})" if _tail(log_path) else "")
        )
    # A source whose audio stream runs a fraction past the container duration
    # can produce one extra trailing segment. The playlist only references the
    # declared grid, so drop the tail instead of failing the whole render.
    for name in files[len(lengths):]:
        try:
            os.remove(os.path.join(output_dir, name))
        except OSError:
            pass


def _ensure_audio(
    job: RenderJob,
    source: str,
    info,
    root: str,
    lengths: list[float],
) -> bool:
    """Render the shared audio renditions once per source signature."""
    manifest = _load_manifest(root) or {}
    if manifest.get("audioReady") and _audio_ready(root, manifest):
        return True
    if not info.audio_streams:
        return False

    temporary = os.path.join(root, f".audio-{uuid.uuid4().hex}")
    shutil.rmtree(temporary, ignore_errors=True)
    os.makedirs(temporary, exist_ok=True)
    try:
        for ordinal, track in enumerate(info.audio_streams):
            _check_canceled(job)
            _render_audio_track(
                job, source, info, track, ordinal, temporary, lengths
            )
            job.progress = 0.85 + 0.1 * ((ordinal + 1) / len(info.audio_streams))
        final = _audio_dir(root)
        shutil.rmtree(final, ignore_errors=True)
        os.replace(temporary, final)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)

    with _lock:
        manifest = _load_manifest(root) or {}
        manifest["audio"] = [
            {
                "ordinal": ordinal,
                "streamIndex": track.index,
                "codec": track.codec,
                "channels": track.channels,
                "language": track.language,
                "title": track.title,
                "default": track.default,
            }
            for ordinal, track in enumerate(info.audio_streams)
        ]
        manifest["audioReady"] = True
        manifest["audioSegmentLengths"] = [float(value) for value in lengths]
        _write_manifest(root, manifest)
    return True


def _publish_quality(
    job: RenderJob,
    session,
    info,
    root: str,
) -> None:
    quality = job.quality
    destination = _quality_dir(root, quality)
    shutil.rmtree(destination, ignore_errors=True)
    os.makedirs(destination, exist_ok=True)

    total_bytes = 0
    for index in range(session.segment_count):
        _check_canceled(job)
        source_path = streaming._segment_path(session, index)
        target_path = os.path.join(destination, f"seg_{index:05d}.ts")
        try:
            os.replace(source_path, target_path)
        except OSError as exc:
            raise RenderError(f"Could not publish segment {index}: {exc}") from exc
        try:
            total_bytes += os.path.getsize(target_path)
        except OSError:
            pass
        job.progress = 0.95 + 0.05 * ((index + 1) / max(1, session.segment_count))

    variant = next(
        (
            item
            for item in streaming.render_options(info)
            if str(item["quality"]) == quality
        ),
        None,
    )
    target_height = int(session.target_height or (variant or {}).get("height") or 0)
    width = int(info.width or 0)
    if width and info.height and target_height:
        width = max(2, round(width * target_height / info.height))
        if width % 2:
            width -= 1
    entry = {
        "quality": quality,
        "label": str((variant or {}).get("name") or f"{target_height}p"),
        "height": target_height,
        "width": width,
        "bitrate": int((variant or {}).get("bitrate") or 0) or 1,
        "copy": bool(session.copy_video),
        "videoCodec": (info.video_codec or "").lower() or None,
        "segmentLengths": [float(value) for value in session.segment_lengths],
        "segmentCount": session.segment_count,
        "bytes": total_bytes,
        "completedAt": time.time(),
    }

    with _lock:
        manifest = _load_manifest(root) or {}
        manifest.setdefault("version", 1)
        manifest["source"] = {
            "name": os.path.basename(session.source),
            "size": os.path.getsize(session.source),
            "mtimeNs": session.signature[0],
        }
        manifest["signature"] = job.signature_key
        manifest["duration"] = float(info.duration or 0.0)
        manifest["hasVideo"] = bool(info.has_video)
        manifest["hasAudio"] = bool(info.audio_streams)
        manifest.setdefault("createdAt", time.time())
        manifest["updatedAt"] = time.time()
        qualities = manifest.get("qualities") or {}
        qualities[quality] = entry
        manifest["qualities"] = qualities
        _write_manifest(root, manifest)


def _run_job(job: RenderJob) -> None:
    job.state = STATE_RENDERING
    job.started_at = time.time()
    job.progress = 0.0
    job.detail = None

    current = _current_source(job.download_id, job.file_index)
    if not current or current[2] != job.signature_key:
        raise RenderError("The source file changed; pre-render it again")
    source, signature, signature_key = current

    info = streaming.probe_source(source)
    if info is None or not info.has_video or not info.duration:
        raise RenderError("This file cannot be pre-rendered")

    root = _render_root(job.download_id, job.file_index, signature_key)
    os.makedirs(root, exist_ok=True)

    temporary = os.path.join(
        streaming.playback_root(), f"render-{uuid.uuid4().hex}"
    )
    shutil.rmtree(temporary, ignore_errors=True)
    session = streaming.build_render_session(
        source,
        signature,
        info,
        job.quality,
        temporary,
        job.file_index,
    )
    if session is None:
        raise RenderError("This quality is not available for the source")
    if session.encoder_name is None and info.has_video and not session.copy_video:
        raise RenderError("No video encoder is available on the worker")

    try:
        _drive_video(job, session)
        # Audio renditions are shared by every quality and use the fixed
        # 6-second grid, so they are rendered once per source signature.
        audio_lengths = streaming._segment_lengths(
            float(info.duration), info.frame_rate
        )
        _ensure_audio(job, source, info, root, audio_lengths)
        _publish_quality(job, session, info, root)
    finally:
        streaming._stop_batch(session)
        shutil.rmtree(temporary, ignore_errors=True)

    manifest = _load_manifest(root) or {}
    entry = (manifest.get("qualities") or {}).get(job.quality) or {}
    job.bytes = int(entry.get("bytes") or 0)
    job.state = STATE_READY
    job.progress = 1.0
    job.speed = None
    job.completed_at = time.time()
    logger.log(
        "info",
        f"Pre-render ready: {job.quality} for {os.path.basename(source)} "
        f"({job.bytes / (1024 * 1024):.0f} MB)",
    )


def _tail(path: str, limit: int = 500) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()[-limit:].strip()
    except OSError:
        return ""


def _hls_text(value: Optional[str]) -> str:
    return (value or "").replace('"', "'").replace("\r", " ").replace("\n", " ").strip()


def _audio_label(track: dict, ordinal: int) -> str:
    title = track.get("title")
    language = track.get("language")
    return _hls_text(title or language or f"Track {ordinal + 1}")


def shutdown() -> None:
    """Cancel active renders and stop the dispatcher."""
    global _shutting_down
    with _lock:
        _shutting_down = True
        jobs = list(_jobs.values())
    for job in jobs:
        job.cancel.set()
    _queue.put(None)
