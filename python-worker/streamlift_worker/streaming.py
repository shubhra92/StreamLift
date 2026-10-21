"""On-demand media delivery for worker-local files (Watch page).

Media never passes through the app server: the browser talks to the worker
tunnel directly, and this module only prepares and serves the bytes.

Two delivery modes, chosen from the client's codec capabilities:

* ``progressive`` — the video stream can be copied into an MP4 (H.264, or
  HEVC/AV1/VP9 when the browser reports support). Audio is copied when the
  browser supports its codec and transcoded to AAC otherwise — so e.g.
  H.264 + AC3 no longer re-encodes the video. The source is remuxed once into
  a faststart MP4 and served with HTTP range support, so the browser shows the
  exact duration and seeking is instant. No HLS is involved.

* ``hls`` — the video has to be re-encoded. A *virtual VOD* stream: the
  complete playlist is computed up front from the probed duration (every
  segment listed, ending with ``#EXT-X-ENDLIST``) and segments are produced in
  sequential batches by a single background encoder. Players therefore see
  real VOD — they start at 0:00, show the true total duration and can seek
  anywhere — instead of a growing "live" stream.

The batch encoder is the important performance property: a seek/decode tax used
to be paid once per 6s segment; now it is paid once per two-minute batch, and
segments are produced sequentially from one continuous decode. A seek outside
the current batch restarts it at the new position.

Idle sessions are torn down by a background reaper.
"""

from __future__ import annotations

import atexit
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import IO, Optional
from urllib.parse import quote

from streamlift_worker import logger
from streamlift_worker.config import (
    HLS_AUDIO_BITRATE,
    HLS_BATCH_SEGMENTS,
    HLS_IDLE_TIMEOUT,
    HLS_MAX_BUFSIZE,
    HLS_MAX_CONCURRENT,
    HLS_MAX_HEIGHT,
    HLS_MAX_RATE,
    HLS_SEGMENT_SECONDS,
    HLS_SEGMENT_TIMEOUT,
    HLS_SEGMENT_WAIT,
    HLS_TRANSCODE_CRF,
    HLS_TRANSCODE_PRESET,
    PLAYBACK_DIR_NAME,
)
from streamlift_worker.local_files import downloads_dir, resolve_completed_file

MODE_PROGRESSIVE = "progressive"
MODE_HLS = "hls"

# Quality identifiers used by the HLS URL layer. "auto" is the default
# rendition used for the ticket/status and the shared audio renditions.
QUALITY_AUTO = "auto"
QUALITY_ORIGINAL = "original"
_QUALITY_RE = re.compile(r"^(auto|original|[1-9][0-9]{2,4})$")
_TRANSCODE_HEIGHTS = (1080, 720, 480, 360)

# Playback states surfaced to the client.
STATE_IDLE = "idle"
STATE_PREPARING = "preparing"
STATE_READY = "ready"
STATE_ERROR = "error"

_MP4_NAME = "media.mp4"
_SEGMENT_RE = re.compile(r"^seg_(\d{5})\.ts$")
_AUDIO_SEGMENT_RE = re.compile(r"^aud_(\d+)_(\d{5})\.ts$")

# Trailing remainders shorter than this are folded into the previous segment:
# a 20ms segment is not worth its own transcode and can transcode to nothing.
_MIN_TAIL_SECONDS = 1.0

# Stream-copied original segments are cheap enough to verify before publishing.
# The tolerance allows MPEG-TS rounding while still catching a segment that
# starts at the wrong keyframe or has a hole in its video timeline.
_COPY_VALIDATE_TIMEOUT = 10.0
_COPY_START_TOLERANCE = 0.75
_COPY_MAX_PTS_GAP = 1.0

# Codecs that can be carried by MP4/MPEG-TS. Whether the *client* can decode
# them is a separate question, answered by the capability string it sends.
_MP4_VIDEO_CODECS = frozenset({"h264", "hevc", "av1", "vp9"})
_MP4_AUDIO_CODECS = frozenset({"aac", "mp3", "opus", "flac", "ac3", "eac3"})

# H.264 High 10/4:2:2/4:4:4 is not decoded by browsers.
_H264_COPY_PIX_FMTS = frozenset({"yuv420p", "yuvj420p", "nv12"})

_KNOWN_VIDEO_CODECS = frozenset({"h264", "hevc", "av1", "vp9", "vp8"})
_KNOWN_AUDIO_CODECS = frozenset({"aac", "mp3", "opus", "flac", "ac3", "eac3", "vorbis"})

# Image-based subtitles cannot be rendered by a browser without burning them
# into the video, which requires a full re-encode. Every other subtitle codec
# is handed to ffmpeg, which knows far more text formats than a hardcoded list.
_BITMAP_SUBTITLE_CODECS = frozenset(
    {"hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub", "dvb_teletext"}
)

# ffprobe results are cached by (path, mtime, size) so repeated playlist
# requests never re-probe the same file.
_probe_cache: dict[tuple[str, int, int], "ProbeInfo | None"] = {}
_probe_lock = threading.Lock()

# Caps concurrent playback ffmpeg jobs across all sessions so playback cannot
# starve active downloads. A batch holds a slot for its lifetime.
_segment_jobs = threading.Semaphore(HLS_MAX_CONCURRENT)
# Audio renditions and thumbnails are cheap and must not queue behind a
# two-minute video batch, so they get their own small pools.
_audio_jobs = threading.Semaphore(4)
_thumbnail_jobs = threading.Semaphore(2)


@dataclass(frozen=True)
class PlaybackCaps:
    """Codecs the client declared it can decode (plus container support)."""

    video: frozenset[str]
    audio: frozenset[str]

    @property
    def serialised(self) -> str:
        return ",".join(sorted(self.video)) + "|" + ",".join(sorted(self.audio))

    @property
    def key(self) -> str:
        return hashlib.sha1(self.serialised.encode("utf-8")).hexdigest()[:10]


DEFAULT_CAPS = PlaybackCaps(frozenset({"h264"}), frozenset({"aac", "mp3"}))


def parse_caps(raw: Optional[str]) -> PlaybackCaps:
    """Parse ``"h264,hevc|aac,mp3"`` into a normalised capability set.

    A missing value means an older client: assume the conservative default
    (H.264 + AAC/MP3), which is exactly what those clients could copy before.
    """
    if raw is None:
        return DEFAULT_CAPS
    raw = raw.strip()
    if not raw:
        return DEFAULT_CAPS
    video_raw, sep, audio_raw = raw.partition("|")
    if not sep:
        audio_raw = ""
    video = frozenset(
        codec.strip().lower()
        for codec in video_raw.split(",")
        if codec.strip().lower() in _KNOWN_VIDEO_CODECS
    )
    audio = frozenset(
        codec.strip().lower()
        for codec in audio_raw.split(",")
        if codec.strip().lower() in _KNOWN_AUDIO_CODECS
    )
    return PlaybackCaps(video, audio)


@dataclass
class AudioTrack:
    """One selectable audio stream in the source file."""

    index: int
    codec: Optional[str] = None
    channels: Optional[int] = None
    language: Optional[str] = None
    title: Optional[str] = None
    default: bool = False


@dataclass
class SubtitleTrack:
    """One subtitle stream; text tracks become WebVTT, bitmap ones cannot."""

    index: int
    codec: Optional[str] = None
    language: Optional[str] = None
    title: Optional[str] = None
    default: bool = False
    forced: bool = False

    @property
    def bitmap(self) -> bool:
        return (self.codec or "").lower() in _BITMAP_SUBTITLE_CODECS


@dataclass
class Chapter:
    start: float
    end: float
    title: str


@dataclass
class ProbeInfo:
    """The streams of a media file that the player can expose."""

    video_index: Optional[int]
    audio_index: Optional[int]
    video_codec: Optional[str]
    audio_codec: Optional[str]
    duration: Optional[float]
    width: Optional[int] = None
    height: Optional[int] = None
    pix_fmt: Optional[str] = None
    frame_rate: Optional[float] = None
    video_bitrate: Optional[int] = None
    audio_streams: list[AudioTrack] = field(default_factory=list)
    subtitle_streams: list[SubtitleTrack] = field(default_factory=list)
    chapters: list[Chapter] = field(default_factory=list)

    @property
    def has_video(self) -> bool:
        return self.video_index is not None

    @property
    def has_audio(self) -> bool:
        return self.audio_index is not None

    @property
    def has_multiple_audio(self) -> bool:
        return len(self.audio_streams) > 1

    def can_copy_video(self, caps: PlaybackCaps) -> bool:
        if not self.has_video:
            return True
        codec = (self.video_codec or "").lower()
        if codec not in caps.video or codec not in _MP4_VIDEO_CODECS:
            return False
        if codec == "h264" and self.pix_fmt and self.pix_fmt not in _H264_COPY_PIX_FMTS:
            return False
        return True

    def can_copy_audio(self, caps: PlaybackCaps) -> bool:
        if not self.has_audio:
            return True
        codec = (self.audio_codec or "").lower()
        return codec in caps.audio and codec in _MP4_AUDIO_CODECS

    def mode_for(self, caps: PlaybackCaps) -> str:
        """Progressive whenever video can be copied *and* only one audio track.

        Multiple audio tracks need HLS alternate renditions so the browser can
        switch without reloading the file; the single-audio fast path is kept
        untouched. Audio the client cannot decode is still transcoded to AAC
        during the progressive remux, which is far cheaper than re-encoding
        video.
        """
        if self.has_multiple_audio:
            return MODE_HLS
        return MODE_PROGRESSIVE if self.can_copy_video(caps) else MODE_HLS

    def target_height(self) -> Optional[int]:
        if not self.has_video or not self.height:
            return None
        return min(int(self.height), int(HLS_MAX_HEIGHT))


@dataclass
class _Batch:
    """One background ffmpeg run producing a contiguous run of segments."""

    process: subprocess.Popen
    first_index: int
    end_index: int
    log_handle: IO[bytes]
    log_path: str
    started_at: float
    last_segment_at: float
    thread: Optional[threading.Thread] = None
    # Set when we kill the batch ourselves (seek preemption / shutdown), so
    # the watcher does not report the resulting exit code as a failure.
    stopped: bool = False


@dataclass
class _Session:
    """Everything the worker knows about one playable file + quality rendition."""

    key: tuple[str, int, str, str]
    source: str
    signature: tuple[int, int]
    info: ProbeInfo
    caps: PlaybackCaps
    mode: str
    output_dir: str
    created_at: float
    last_access: float
    segment_lengths: list[float]
    quality: str = QUALITY_AUTO
    target_height: Optional[int] = None
    copy_video: bool = False
    encoder_name: Optional[str] = None
    encoder_args: tuple[str, ...] = ()
    state: str = STATE_IDLE
    progress: float = 0.0
    speed: Optional[float] = None
    detail: Optional[str] = None
    process: Optional[subprocess.Popen] = None
    batch: Optional[_Batch] = None
    completed: set[int] = field(default_factory=set)
    # Original-quality segments that failed stream-copy validation. They are
    # regenerated with a one-off video transcode when a player asks for them.
    fallback_segments: set[int] = field(default_factory=set)
    copy_validation_failures: int = 0
    batch_failures: int = 0
    last_batch_failure: float = 0.0
    # Serialises "should I start/stop a batch" decisions. Reentrant because
    # _ensure_batch calls _stop_batch while holding it.
    batch_lock: threading.RLock = field(default_factory=threading.RLock)
    condition: threading.Condition = field(default_factory=threading.Condition)

    @property
    def segment_length(self) -> float:
        return self.segment_lengths[0] if self.segment_lengths else float(HLS_SEGMENT_SECONDS)

    @property
    def segment_count(self) -> int:
        return len(self.segment_lengths)


_sessions: dict[tuple[str, int, str, str], _Session] = {}
_sessions_lock = threading.Lock()
_reaper_started = False


# ── Helpers ───────────────────────────────────────────────────────────────────


def playback_root() -> str:
    path = os.path.join(downloads_dir(), PLAYBACK_DIR_NAME)
    os.makedirs(path, exist_ok=True)
    return path


def _source_signature(path: str) -> Optional[tuple[int, int]]:
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


def _remove_file(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _tail(path: str, limit: int = 800) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()[-limit:].strip()
    except OSError:
        return ""


def _parse_rate(value: object) -> Optional[float]:
    """Parse ffprobe's ``"24000/1001"`` frame rate into a float."""
    if not value or not isinstance(value, str):
        return None
    numerator, _, denominator = value.partition("/")
    try:
        rate = float(numerator) / float(denominator or 1)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    if not math.isfinite(rate) or rate <= 0:
        return None
    return rate if 1.0 <= rate <= 240.0 else None


def _segment_lengths(duration: float, fps: Optional[float] = None) -> list[float]:
    """Declared duration of every segment, in order.

    When the frame rate is known, the nominal segment length is rounded to a
    whole number of frames (e.g. 6.006s at 23.976fps). That keeps forced
    keyframes exactly on segment boundaries, so the segment muxer cuts once per
    segment instead of occasionally skipping a boundary. The final segment is
    shorter than a full one; when the remainder is tiny it is folded into the
    previous segment.
    """
    segment = float(HLS_SEGMENT_SECONDS)
    if fps and 1.0 <= fps <= 240.0:
        frames = max(1, int(round(segment * fps)))
        segment = frames / fps

    duration = float(duration or 0.0)
    if duration <= 0:
        return [segment]

    count = max(1, math.ceil(duration / segment - 1e-9))
    lengths = [segment] * count
    tail = duration - (count - 1) * segment
    if count > 1 and tail < _MIN_TAIL_SECONDS:
        lengths.pop()
        lengths[-1] += tail
    else:
        lengths[-1] = max(tail, 0.001)
    return lengths


def _segment_count(duration: float, fps: Optional[float] = None) -> int:
    return len(_segment_lengths(duration, fps))


# ── HLS quality renditions ───────────────────────────────────────────────────

# Keyframe timestamps are needed for the stream-copy "original" rendition:
# copied video can only be cut on source keyframes. Cache the (small) list for
# the lifetime of the worker.
_keyframe_cache: dict[tuple[str, int, int, int], Optional[list[float]]] = {}
_keyframe_lock = threading.Lock()

_VARIANT_BITRATES = {
    2160: 20_000_000,
    1440: 10_000_000,
    1080: 5_000_000,
    720: 3_000_000,
    480: 1_500_000,
    360: 800_000,
}


def _normalise_quality(raw: Optional[str]) -> Optional[str]:
    """Validate a quality id from a URL. Unknown values must not reach disk."""
    if raw is None or raw == "" or raw == QUALITY_AUTO:
        return QUALITY_AUTO
    value = str(raw).strip()
    return value if _QUALITY_RE.fullmatch(value) else None


def _can_copy_hls(info: ProbeInfo) -> bool:
    """True when the source video can be stream-copied into MPEG-TS HLS.

    H.264 is deliberately the first copy-safe codec: it is the universally
    playable HLS codec. HEVC/AV1 would need fragmented-MP4 HLS and browser
    support; those sources fall back to transcoded renditions for now.
    """
    if not info.has_video or not info.height:
        return False
    if (info.video_codec or "").lower() != "h264":
        return False
    if info.pix_fmt and info.pix_fmt not in _H264_COPY_PIX_FMTS:
        return False
    return True


def _keyframe_times(source: str, info: ProbeInfo) -> Optional[list[float]]:
    """Return source keyframe timestamps in seconds, cached by file signature.

    ``-show_entries packet=...`` avoids decoding the whole file. Only packets
    with the K flag are retained. A source with no detectable keyframes cannot
    be stream-copied into segmented HLS, so callers fall back to transcoding or
    omit the original rendition.
    """
    if info.video_index is None or not info.duration or info.duration <= 0:
        return None
    signature = _source_signature(source)
    if signature is None:
        return None
    cache_key = (source, signature[0], signature[1], int(info.video_index))
    with _keyframe_lock:
        cached = _keyframe_cache.get(cache_key)
        if cached is not None or cache_key in _keyframe_cache:
            return cached

    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    cmd = [
        ffprobe,
        "-v", "error",
        "-select_streams", "v",
        "-show_entries", "packet=stream_index,pts_time,flags",
        "-of", "json",
        source,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return None

    times: list[float] = []
    video_index = int(info.video_index)
    for packet in payload.get("packets", []) or []:
        try:
            if int(packet.get("stream_index")) != video_index:
                continue
            flags = str(packet.get("flags") or "")
            if "K" not in flags:
                continue
            value = float(packet.get("pts_time"))
        except (TypeError, ValueError):
            continue
        if math.isfinite(value) and value >= 0:
            times.append(value)
    times.sort()
    deduped: list[float] = []
    for value in times:
        if not deduped or value - deduped[-1] > 0.01:
            deduped.append(value)
    result_times = deduped or None
    with _keyframe_lock:
        if len(_keyframe_cache) >= 128:
            _keyframe_cache.clear()
        _keyframe_cache[cache_key] = result_times
    return result_times


def _copy_segment_lengths(source: str, info: ProbeInfo) -> Optional[list[float]]:
    """Build segment lengths from actual keyframe positions for copy video."""
    duration = float(info.duration or 0.0)
    keyframes = _keyframe_times(source, info)
    if not keyframes or duration <= 0:
        return None

    boundaries: list[float] = [0.0]
    next_target = float(HLS_SEGMENT_SECONDS)
    for value in keyframes:
        if value <= 0.01 or value >= duration - 0.01:
            continue
        # Coalesce frequent keyframes to roughly HLS_SEGMENT_SECONDS so the
        # playlist does not explode into thousands of tiny segments.
        if value >= next_target - 0.01:
            boundaries.append(value)
            next_target = value + float(HLS_SEGMENT_SECONDS)
    boundaries.append(duration)

    lengths = [max(0.001, boundaries[i + 1] - boundaries[i]) for i in range(len(boundaries) - 1)]
    if len(lengths) > 1 and lengths[-1] < _MIN_TAIL_SECONDS:
        lengths[-2] += lengths[-1]
        lengths.pop()
    return lengths or [duration]


def _quality_variants(info: ProbeInfo) -> list[dict[str, object]]:
    """Source-aware HLS ladder, highest quality first.

    The original-quality rendition is a video stream copy when possible and is
    not subject to the transcode height cap. Re-encoded renditions use the
    configured cap and never upscale. If an original copy is unavailable (for
    example HEVC in MPEG-TS), the best transcode at or below the cap is still
    offered.
    """
    source_height = int(info.height or 0)
    variants: list[dict[str, object]] = []
    seen: set[int] = set()

    def add(quality: str, height: int, copy: bool) -> None:
        if height <= 0 or height in seen:
            return
        seen.add(height)
        variants.append(
            {
                "quality": quality,
                "name": f"Original ({height}p)" if copy else f"{height}p",
                "height": height,
                "copy": copy,
                "bitrate": (
                    (
                        int(info.video_bitrate)
                        if info.video_bitrate and info.video_bitrate > 0
                        else _VARIANT_BITRATES.get(height, 6_000_000)
                    )
                    if copy
                    else _VARIANT_BITRATES.get(height, 4_000_000)
                ),
            }
        )

    copyable = _can_copy_hls(info)
    if copyable:
        add(QUALITY_ORIGINAL, source_height, True)

    max_height = int(HLS_MAX_HEIGHT)
    limit = min(source_height, max_height) if source_height else max_height
    if limit > 0:
        # If there is no copy variant, the cap itself is the best available
        # transcode (e.g. 1080p HEVC). Never duplicate an original height.
        if not variants or limit < source_height:
            add(str(limit), limit, False)
        for height in _TRANSCODE_HEIGHTS:
            if height < limit:
                add(str(height), height, False)
    return variants


def _quality_target_height(info: ProbeInfo, quality: str) -> Optional[int]:
    """Output height for one quality id, or None when it is not available."""
    source_height = int(info.height or 0)
    if quality == QUALITY_ORIGINAL:
        return source_height or None
    if quality == QUALITY_AUTO:
        return min(source_height, int(HLS_MAX_HEIGHT)) if source_height else None
    try:
        height = int(quality)
    except (TypeError, ValueError):
        return None
    if height <= 0 or height > int(HLS_MAX_HEIGHT):
        return None
    if source_height and height > source_height:
        return None
    return height


def _probe(path: str) -> Optional[ProbeInfo]:
    """Run ffprobe once per (path, mtime, size) and cache the result."""
    try:
        stat = os.stat(path)
        cache_key = (path, stat.st_mtime_ns, stat.st_size)
    except OSError:
        return None

    with _probe_lock:
        if cache_key in _probe_cache:
            return _probe_cache[cache_key]

    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        logger.log("error", "ffprobe is not installed — cannot prepare playback")
        return None

    cmd = [
        ffprobe,
        "-v", "error",
        "-print_format", "json",
        "-show_streams",
        "-show_format",
        "-show_chapters",
        path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as exc:
        logger.log("warning", f"ffprobe failed for playback: {exc}")
        return None

    if result.returncode != 0:
        logger.log("warning", f"ffprobe exited {result.returncode}: {result.stderr.strip()[:300]}")
        return None

    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return None

    video_index: Optional[int] = None
    audio_index: Optional[int] = None
    video_codec: Optional[str] = None
    audio_codec: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    pix_fmt: Optional[str] = None
    frame_rate: Optional[float] = None
    video_bitrate: Optional[int] = None
    audio_streams: list[AudioTrack] = []
    subtitle_streams: list[SubtitleTrack] = []

    for stream in payload.get("streams", []):
        # Skip embedded cover art — an mp3 with artwork still has no video.
        disposition = stream.get("disposition") or {}
        if disposition.get("attached_pic"):
            continue
        codec_type = stream.get("codec_type")
        tags = stream.get("tags") or {}
        if codec_type == "video" and video_index is None:
            video_index = stream.get("index")
            video_codec = stream.get("codec_name")
            pix_fmt = stream.get("pix_fmt")
            frame_rate = _parse_rate(stream.get("avg_frame_rate")) or _parse_rate(
                stream.get("r_frame_rate")
            )
            try:
                width = int(stream.get("width") or 0) or None
                height = int(stream.get("height") or 0) or None
            except (TypeError, ValueError):
                width = height = None
            try:
                video_bitrate = int(stream.get("bit_rate") or 0) or None
            except (TypeError, ValueError):
                video_bitrate = None
        elif codec_type == "audio":
            try:
                channels = int(stream.get("channels") or 0) or None
            except (TypeError, ValueError):
                channels = None
            track = AudioTrack(
                index=int(stream.get("index") or 0),
                codec=stream.get("codec_name"),
                channels=channels,
                language=tags.get("language"),
                title=tags.get("title"),
                default=bool(disposition.get("default")),
            )
            audio_streams.append(track)
            if audio_index is None:
                audio_index = track.index
                audio_codec = track.codec
        elif codec_type == "subtitle":
            subtitle_streams.append(
                SubtitleTrack(
                    index=int(stream.get("index") or 0),
                    codec=stream.get("codec_name"),
                    language=tags.get("language"),
                    title=tags.get("title"),
                    default=bool(disposition.get("default")),
                    forced=bool(disposition.get("forced")),
                )
            )

    if video_index is None and audio_index is None:
        return None

    chapters: list[Chapter] = []
    for raw in payload.get("chapters", []) or []:
        try:
            start = float(raw.get("start_time") or 0)
            end = float(raw.get("end_time") or 0)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(start) or not math.isfinite(end) or end <= start:
            continue
        tags = raw.get("tags") or {}
        chapters.append(
            Chapter(
                start=start,
                end=end,
                title=str(tags.get("title") or f"Chapter {len(chapters) + 1}"),
            )
        )

    duration: Optional[float] = None
    try:
        duration = float((payload.get("format") or {}).get("duration") or 0) or None
    except (TypeError, ValueError):
        duration = None

    info = ProbeInfo(
        video_index=video_index,
        audio_index=audio_index,
        video_codec=video_codec,
        audio_codec=audio_codec,
        duration=duration,
        width=width,
        height=height,
        pix_fmt=pix_fmt,
        frame_rate=frame_rate,
        video_bitrate=video_bitrate,
        audio_streams=audio_streams,
        subtitle_streams=subtitle_streams,
        chapters=chapters,
    )

    with _probe_lock:
        if len(_probe_cache) >= 256:
            _probe_cache.clear()
        _probe_cache[cache_key] = info
    return info


# ── Video encoder selection ───────────────────────────────────────────────────


_encoder_lock = threading.Lock()
_encoder_cache: Optional[tuple[str, tuple[str, ...]]] = None


def _test_encoder(ffmpeg: str, args: tuple[str, ...]) -> bool:
    """Run a one-frame encode to prove the encoder and its options work."""
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.1",
        "-frames:v", "1",
        *args,
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(
            cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _video_encoder() -> tuple[str, tuple[str, ...]]:
    """Pick the fastest working H.264 encoder (NVENC when a GPU is present).

    ``STREAMLIFT_VIDEO_ENCODER=libx264`` (or ``nvenc``) can force a choice.
    The result is cached for the process lifetime; a failed NVENC probe falls
    back to libx264 so a broken driver can never break playback.
    """
    global _encoder_cache
    with _encoder_lock:
        if _encoder_cache is not None:
            return _encoder_cache

        ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
        forced = os.environ.get("STREAMLIFT_VIDEO_ENCODER", "").strip().lower()

        if forced != "libx264" and (forced == "nvenc" or shutil.which("nvidia-smi")):
            nvenc_args: tuple[str, ...] = (
                "-c:v", "h264_nvenc",
                "-rc", "vbr",
                "-cq", str(HLS_TRANSCODE_CRF),
                "-b:v", "0",
                "-maxrate", HLS_MAX_RATE,
                "-bufsize", HLS_MAX_BUFSIZE,
                "-no-scenecut", "1",
                "-bf", "0",
                "-g", "100000",
                "-pix_fmt", "yuv420p",
            )
            if _test_encoder(ffmpeg, nvenc_args):
                logger.log("info", "Playback transcodes will use h264_nvenc (GPU)")
                _encoder_cache = ("h264_nvenc", nvenc_args)
                return _encoder_cache
            logger.log("warning", "h264_nvenc is unavailable or failed its probe; using libx264")

        libx264_args: tuple[str, ...] = (
            "-c:v", "libx264",
            "-preset", HLS_TRANSCODE_PRESET,
            "-crf", str(HLS_TRANSCODE_CRF),
            "-maxrate", HLS_MAX_RATE,
            "-bufsize", HLS_MAX_BUFSIZE,
            "-sc_threshold", "0",
            "-bf", "0",
            "-g", "100000",
            "-pix_fmt", "yuv420p",
        )
        _encoder_cache = ("libx264", libx264_args)
        return _encoder_cache


def _video_filter(info: ProbeInfo, target: Optional[int]) -> Optional[str]:
    """Scale down (never up) to the requested rendition, keeping aspect ratio."""
    if target and info.height and info.height > target:
        return f"scale=-2:{target}"
    return None


# ── Progressive mode ──────────────────────────────────────────────────────────


def _build_progressive_command(session: _Session, output_path: str) -> list[str]:
    """Remux into a faststart MP4, copying whatever the client can decode."""
    info = session.info
    caps = session.caps
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", session.source]
    if info.has_video:
        cmd += ["-map", f"0:{info.video_index}"]
    if info.has_audio:
        cmd += ["-map", f"0:{info.audio_index}"]

    if info.has_video:
        cmd += ["-c:v", "copy"]
        if (info.video_codec or "").lower() == "hevc":
            # Browsers generally accept hvc1, not hev1, in MP4.
            cmd += ["-tag:v", "hvc1"]

    if info.has_audio:
        if info.can_copy_audio(caps):
            cmd += ["-c:a", "copy"]
        else:
            # H.264 + AC3/DTS/TrueHD etc: re-encode only the audio; the
            # video is still a straight copy.
            cmd += ["-c:a", "aac", "-b:a", HLS_AUDIO_BITRATE, "-ac", "2"]

    cmd += [
        "-sn", "-dn",
        # moov atom first so the browser can start playing from the front.
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-nostats",
        "-f", "mp4",
        output_path,
    ]
    return cmd


def _progress_seconds(line: str) -> Optional[float]:
    """Parse one ffmpeg -progress line into a media timestamp (seconds)."""
    key, sep, value = line.partition("=")
    if not sep:
        return None
    key = key.strip()
    value = value.strip()
    if key in ("out_time_us", "out_time_ms"):
        # ffmpeg reports both keys in microseconds.
        try:
            return int(value) / 1_000_000
        except ValueError:
            return None
    if key == "out_time":
        try:
            hours, minutes, seconds = value.split(":")
            return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
        except ValueError:
            return None
    return None


def _progress_speed(line: str) -> Optional[float]:
    """Parse ffmpeg's ``speed=1.25x`` progress line."""
    key, sep, value = line.partition("=")
    if not sep or key.strip() != "speed":
        return None
    try:
        speed = float(value.strip().rstrip("x"))
    except ValueError:
        return None
    return speed if math.isfinite(speed) and speed > 0 else None


def _start_progressive(session: _Session) -> None:
    """Start (idempotently) the one-time remux for a progressive session."""
    if session.mode != MODE_PROGRESSIVE:
        return
    if session.state == STATE_PREPARING and session.process is not None:
        return

    final_path = os.path.join(session.output_dir, _MP4_NAME)
    if os.path.isfile(final_path) and os.path.getsize(final_path) > 0:
        session.state = STATE_READY
        session.progress = 1.0
        session.speed = None
        session.detail = None
        return

    partial = final_path + ".part"
    _remove_file(partial)
    log_path = os.path.join(session.output_dir, "remux.log")
    cmd = _build_progressive_command(session, partial)
    try:
        log_handle = open(log_path, "wb")
        process = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=log_handle,
        )
    except OSError as exc:
        _remove_file(partial)
        session.state = STATE_ERROR
        session.detail = "The worker could not start converting this file"
        logger.log("warning", f"Could not start playback remux: {exc}")
        return

    session.process = process
    session.state = STATE_PREPARING
    session.progress = 0.0
    session.speed = None
    session.detail = None
    logger.log("info", f"Playback remux started for {os.path.basename(session.source)}")
    threading.Thread(
        target=_watch_progressive,
        args=(session, process, log_handle, partial, final_path),
        daemon=True,
        name="playback-remux",
    ).start()


def _watch_progressive(
    session: _Session,
    process: subprocess.Popen,
    log_handle: IO[bytes],
    partial: str,
    final_path: str,
) -> None:
    """Follow a remux job, reporting progress and publishing the result."""
    duration = session.info.duration or 0.0
    try:
        if process.stdout is not None:
            for raw in process.stdout:
                line = raw.decode("utf-8", "replace").strip()
                speed = _progress_speed(line)
                if speed is not None:
                    session.speed = speed
                if duration <= 0:
                    continue
                seconds = _progress_seconds(line)
                if seconds is not None:
                    session.progress = max(0.0, min(1.0, seconds / duration))
    except (OSError, ValueError):
        pass
    finally:
        try:
            if process.stdout is not None:
                process.stdout.close()
        except OSError:
            pass
        returncode = process.wait()
        try:
            log_handle.close()
        except OSError:
            pass

    if returncode == 0 and os.path.isfile(partial) and os.path.getsize(partial) > 0:
        try:
            os.replace(partial, final_path)
        except OSError as exc:
            _remove_file(partial)
            session.state = STATE_ERROR
            session.detail = "The converted file could not be published"
            logger.log("warning", f"Playback remux could not be published: {exc}")
        else:
            session.progress = 1.0
            session.speed = None
            session.state = STATE_READY
            session.detail = None
            logger.log("info", f"Playback copy ready for {os.path.basename(session.source)}")
    else:
        _remove_file(partial)
        session.state = STATE_ERROR
        session.detail = "This file could not be prepared for playback"
        logger.log(
            "warning",
            f"Playback remux failed ({returncode}): "
            f"{_tail(os.path.join(session.output_dir, 'remux.log'))}",
        )
    session.process = None


# ── Virtual-VOD HLS mode ──────────────────────────────────────────────────────


def _playlist_header(session: _Session) -> list[str]:
    lengths = session.segment_lengths
    return [
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        f"#EXT-X-TARGETDURATION:{math.ceil(max(lengths))}",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-INDEPENDENT-SEGMENTS",
    ]


def _quality_query(session: _Session) -> str:
    """Query suffix that maps a segment back to this quality rendition."""
    if session.quality == QUALITY_AUTO:
        return ""
    return f"&q={quote(session.quality, safe='')}"


def _build_vod_playlist(session: _Session) -> str:
    """The complete video playlist for one quality rendition.

    Because every segment is listed and the playlist ends with
    ``#EXT-X-ENDLIST``, players treat it as real VOD: they start at 0:00, show
    the true total duration and seek anywhere. Segments appear on demand.

    The client's capability string and quality id travel on every segment URL,
    so a request maps back to the same session/artifact directory. No auth token
    is needed: the tunnel URL itself is the secret.
    """
    lengths = session.segment_lengths
    caps_query = quote(session.caps.serialised, safe="")
    quality_query = _quality_query(session)
    lines = _playlist_header(session)
    for index, length in enumerate(lengths):
        lines.append(f"#EXTINF:{length:.3f},")
        lines.append(f"seg_{index:05d}.ts?caps={caps_query}{quality_query}")
    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


def _build_audio_playlist(session: _Session, track: int) -> str:
    """Media playlist for one audio rendition (audio-only TS)."""
    lengths = session.segment_lengths
    caps_query = quote(session.caps.serialised, safe="")
    quality_query = _quality_query(session)
    lines = _playlist_header(session)
    for index, length in enumerate(lengths):
        lines.append(f"#EXTINF:{length:.3f},")
        # The playlist lives at .../{file_index}/audio/{track}.m3u8, while
        # audio segments share the file-index directory with video segments.
        lines.append(
            f"../aud_{track}_{index:05d}.ts?caps={caps_query}{quality_query}"
        )
    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


def _hls_text(value: Optional[str]) -> str:
    """Make a free-form title safe inside an HLS quoted attribute."""
    return (value or "").replace('"', "'").replace("\r", " ").replace("\n", " ").strip()


def _audio_label(track: AudioTrack, ordinal: int) -> str:
    return _hls_text(track.title or track.language or f"Track {ordinal + 1}")


def _build_master_playlist(session: _Session) -> str:
    """Master playlist with quality variants and alternate audio renditions.

    The original variant (when the source can be copied into MPEG-TS HLS) is
    first, followed by source-aware transcoded renditions. hls.js exposes these
    as ``levels`` so the player's existing quality menu can switch between them.
    Alternate audio tracks live in a shared group so changing quality never
    changes the selected language.
    """
    info = session.info
    caps_query = quote(session.caps.serialised, safe="")
    # Version 6 covers EXT-X-MEDIA audio groups and
    # EXT-X-INDEPENDENT-SEGMENTS. Media playlists remain version 3 (MPEG-TS).
    lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-INDEPENDENT-SEGMENTS"]

    tracks = info.audio_streams
    default_ordinal = next((i for i, track in enumerate(tracks) if track.default), 0)
    names: set[str] = set()
    for ordinal, track in enumerate(tracks):
        name = _audio_label(track, ordinal)
        if name in names:
            name = f"{name} ({ordinal + 1})"
        names.add(name)
        attrs = [
            'TYPE=AUDIO',
            'GROUP-ID="aud"',
            f'NAME="{name}"',
            f'DEFAULT={"YES" if ordinal == default_ordinal else "NO"}',
            "AUTOSELECT=YES",
        ]
        if track.language:
            attrs.append(f'LANGUAGE="{_hls_text(track.language)}"')
        # Every rendition is transcoded to stereo AAC in the auto session.
        attrs.append('CHANNELS="2"')
        attrs.append(f'URI="audio/{ordinal}.m3u8?caps={caps_query}"')
        lines.append("#EXT-X-MEDIA:" + ",".join(attrs))

    audio_attr = ',AUDIO="aud"' if tracks else ""
    if info.has_video:
        variants = _quality_variants(info)
        for variant in variants:
            height = int(variant["height"] or 0)
            width = info.width or 0
            if width and info.height and height:
                # Keep the declared rendition resolution in the source aspect
                # ratio; -2:height preserves it during encoding.
                width = max(2, round(width * height / info.height))
                if width % 2:
                    width -= 1
            resolution = f",RESOLUTION={width}x{height}" if width and height else ""
            # NAME is a hls.js-friendly label (native HLS ignores it); it makes
            # the quality menu say "Original" rather than just "2160p".
            name_attr = f',NAME="{_hls_text(str(variant["name"]))}"'
            lines.append(
                f"#EXT-X-STREAM-INF:BANDWIDTH={int(variant['bitrate'])}"
                f"{resolution}{name_attr}{audio_attr},CLOSED-CAPTIONS=NONE"
            )
            quality = str(variant["quality"])
            lines.append(
                f"video.m3u8?caps={caps_query}&q={quote(quality, safe='')}"
            )
    else:
        # Audio-only file: expose every language through the audio group and
        # point the single variant at the default rendition.
        lines.append(
            '#EXT-X-STREAM-INF:BANDWIDTH=192000,AUDIO="aud",CLOSED-CAPTIONS=NONE'
        )
        lines.append(f"audio/{default_ordinal}.m3u8?caps={caps_query}")

    return "\n".join(lines) + "\n"


def _audio_segment_path(session: _Session, track: int, index: int) -> str:
    return os.path.join(session.output_dir, f"aud_{track}_{index:05d}.ts")


def _segment_path(session: _Session, index: int) -> str:
    return os.path.join(session.output_dir, f"seg_{index:05d}.ts")


def _segment_ok(session: _Session, index: int) -> bool:
    path = _segment_path(session, index)
    try:
        return (
            index in session.completed
            and os.path.isfile(path)
            and os.path.getsize(path) > 0
        )
    except OSError:
        return False


def _validate_copy_segment(
    session: _Session, index: int, path: str
) -> tuple[bool, str]:
    """Check that a stream-copied segment really contains a usable video GOP.

    The copy path trusts the source keyframe index. If a source has a damaged
    GOP, a bad edit, or timestamps that the segment muxer cuts badly, ffmpeg
    still exits successfully and writes a tiny/frozen segment. Catch that
    before marking the segment complete so the normal playlist never exposes
    the bad file.

    This reads packet headers only (no decode), and runs in the batch watcher.
    """
    if not session.copy_video:
        return True, ""

    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        # Preparing a session already requires ffprobe; do not make playback
        # worse if it disappears between preparation and segment generation.
        return True, ""

    lengths = session.segment_lengths
    if index >= len(lengths):
        return False, "segment is outside the playlist"
    expected_start = sum(lengths[:index])
    expected_length = lengths[index]

    cmd = [
        ffprobe, "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "packet=stream_index,pts_time,dts_time,flags",
        "-of", "json",
        path,
    ]
    try:
        result = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=_COPY_VALIDATE_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return False, "ffprobe timed out"
    except OSError as exc:
        return False, f"ffprobe could not run ({exc})"

    if result.returncode != 0:
        return False, "ffprobe could not read the segment"
    try:
        payload = json.loads(result.stdout or b"{}")
    except (TypeError, ValueError):
        return False, "ffprobe returned invalid JSON"

    packets = payload.get("packets") or []
    timed: list[tuple[float, str]] = []
    video_index = session.info.video_index
    for packet in packets:
        if not isinstance(packet, dict):
            continue
        packet_stream = packet.get("stream_index")
        if (
            video_index is not None
            and packet_stream is not None
            and packet_stream != video_index
        ):
            continue
        raw = packet.get("pts_time")
        if raw in (None, "N/A"):
            raw = packet.get("dts_time")
        try:
            timestamp = float(raw)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(timestamp):
            continue
        timed.append((timestamp, str(packet.get("flags") or "")))

    if not timed:
        return False, "no video packets"
    timed.sort(key=lambda item: item[0])

    first_time, first_flags = timed[0]
    if "K" not in first_flags:
        return False, "does not start with a keyframe"

    tolerance = _COPY_START_TOLERANCE
    if abs(first_time - expected_start) > tolerance:
        return False, (
            f"starts at {first_time:.3f}s, expected {expected_start:.3f}s"
        )

    if expected_length > 0:
        last_time = timed[-1][0]
        if last_time < first_time + expected_length * 0.7:
            return False, (
                f"covers only {last_time - first_time:.3f}s of "
                f"{expected_length:.3f}s"
            )

    max_gap = 0.0
    for previous, current in zip(timed, timed[1:]):
        max_gap = max(max_gap, current[0] - previous[0])
    frame_rate = float(session.info.frame_rate or 0.0)
    allowed_gap = max(
        _COPY_MAX_PTS_GAP,
        4.0 / frame_rate if frame_rate > 0 else 0.0,
    )
    if max_gap > allowed_gap:
        return False, f"has a {max_gap:.3f}s timestamp gap"

    return True, ""


def _build_batch_command(
    session: _Session,
    first_index: int,
    end_index: int,
    list_path: str,
    output_pattern: str,
) -> list[str]:
    """Transcode a contiguous run of segments with ONE ffmpeg process.

    ``-output_ts_offset`` places the whole run on the absolute timeline (the
    segment muxer normalises the first segment to zero otherwise). The forced
    keyframes are relative to the run, so they land exactly on segment
    boundaries; ``lt(n_forced, N)`` suppresses the keyframe at the very end so
    the last segment is not split into an extra one-frame file.
    """
    info = session.info
    lengths = session.segment_lengths
    start = sum(lengths[:first_index])
    end = sum(lengths[:end_index])
    length = max(0.001, end - start)
    count = end_index - first_index
    segment = session.segment_length

    cmd = [
        "ffmpeg", "-hide_banner", "-nostdin", "-y",
        # Input options: read only this batch from the source.
        "-ss", f"{start:.6f}",
        "-t", f"{max(0.001, length - 0.001):.6f}",
        "-i", session.source,
    ]
    if info.has_video:
        cmd += ["-map", f"0:{info.video_index}"]
        if session.copy_video:
            # Original quality: copy the source video packets. Segment
            # boundaries were built from the source's real keyframes, so the
            # segment muxer can cut without re-encoding.
            cmd += ["-c:v", "copy"]
        else:
            cmd += list(session.encoder_args)
            video_filter = _video_filter(info, session.target_height)
            if video_filter:
                cmd += ["-vf", video_filter]
            cmd += [
                "-force_key_frames",
                f"expr:gte(t,n_forced*{segment:.6f})*lt(n_forced,{count})",
            ]
    # HLS audio is always a separate rendition. This keeps every video variant
    # audio-free and lets hls.js switch video quality without restarting the
    # selected language. The audio rendition lives in the auto session.
    cmd += ["-an"]

    cmd += [
        "-muxdelay", "0", "-muxpreload", "0",
        # Absolute placement of the run on the media timeline. Do NOT use
        # setpts here: the segment muxer normalises stream timestamps, while
        # output_ts_offset is applied by each inner mpegts muxer.
        "-output_ts_offset", f"{start:.6f}",
        "-f", "segment",
        # For transcodes, cut at the first forced keyframe at/after 80% of the
        # segment length. For stream copies there are no forced keyframes; the
        # segment muxer cuts at the next source keyframe instead.
        "-segment_time", (
            f"{float(HLS_SEGMENT_SECONDS):.6f}"
            if session.copy_video
            else f"{max(0.2, segment * 0.8):.6f}"
        ),
        "-segment_format", "mpegts",
        "-reset_timestamps", "0",
        "-segment_start_number", str(first_index),
        "-segment_list", list_path,
        "-segment_list_flags", "+live",
        "-segment_list_type", "csv",
        "-progress", "pipe:1",
        "-nostats",
        output_pattern,
    ]
    return cmd


def _consume_segment_list(session: _Session, batch: _Batch, path: str, position: int) -> int:
    """Mark newly completed segment files from ffmpeg's live CSV list."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            handle.seek(position)
            data = handle.read()
            end = data.rfind("\n")
            if end < 0:
                return position
            new_position = position + end + 1
            complete, position = data[: end + 1], new_position
    except OSError:
        return position

    added = False
    for line in complete.splitlines():
        name = line.split(",", 1)[0].strip()
        match = _SEGMENT_RE.match(os.path.basename(name))
        if not match:
            continue
        index = int(match.group(1))
        if not (batch.first_index <= index < batch.end_index):
            continue

        segment_path = _segment_path(session, index)
        try:
            if not os.path.isfile(segment_path) or os.path.getsize(segment_path) == 0:
                continue
        except OSError:
            continue

        with session.condition:
            if index in session.completed or index in session.fallback_segments:
                continue

        if session.copy_video:
            valid, reason = _validate_copy_segment(session, index, segment_path)
            if not valid:
                # Never advertise a broken original segment. A player request
                # for this index will regenerate it with a one-off transcode.
                _remove_file(segment_path)
                with session.condition:
                    session.fallback_segments.add(index)
                    session.copy_validation_failures += 1
                logger.log(
                    "warning",
                    f"Original segment {index} failed validation for "
                    f"{os.path.basename(session.source)} ({reason}); "
                    "will transcode that segment on demand",
                )
                added = True
                continue

        with session.condition:
            if index not in session.completed:
                session.completed.add(index)
                added = True
    if added:
        batch.last_segment_at = time.monotonic()
        with session.condition:
            session.condition.notify_all()
    return position


def _kill_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    try:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
    except OSError:
        pass


def _read_batch_progress(session: _Session, batch: _Batch) -> None:
    try:
        if batch.process.stdout is None:
            return
        for raw in batch.process.stdout:
            speed = _progress_speed(raw.decode("utf-8", "replace").strip())
            if speed is not None:
                session.speed = speed
    except (OSError, ValueError):
        pass
    finally:
        try:
            if batch.process.stdout is not None:
                batch.process.stdout.close()
        except OSError:
            pass


def _watch_batch(session: _Session, batch: _Batch, list_path: str) -> None:
    """Track a batch to completion, publishing segments as ffmpeg closes them."""
    position = 0
    failure: Optional[str] = None
    try:
        while True:
            position = _consume_segment_list(session, batch, list_path, position)
            if batch.process.poll() is not None:
                break
            if time.monotonic() - batch.last_segment_at > HLS_SEGMENT_TIMEOUT:
                failure = f"no segment completed in {HLS_SEGMENT_TIMEOUT}s"
                logger.log(
                    "warning",
                    f"Playback batch timed out for {os.path.basename(session.source)}: {failure}",
                )
                _kill_process(batch.process)
                break
            time.sleep(0.1)

        position = _consume_segment_list(session, batch, list_path, position)
        returncode = batch.process.wait()
        # The final segment's list line is only written once ffmpeg exits.
        _consume_segment_list(session, batch, list_path, position)
        if returncode != 0 and failure is None and not batch.stopped:
            failure = f"ffmpeg exited {returncode}"
    except Exception as exc:  # pragma: no cover - defensive watchdog
        failure = str(exc)
        logger.log("warning", f"Playback batch watcher failed: {exc}")
        _kill_process(batch.process)
    finally:
        try:
            batch.log_handle.close()
        except OSError:
            pass

        with session.condition:
            if failure is not None:
                session.batch_failures += 1
                session.last_batch_failure = time.monotonic()
            else:
                session.batch_failures = 0
            if session.batch is batch:
                session.batch = None
            session.condition.notify_all()

        if failure is not None:
            logger.log(
                "warning",
                f"Playback batch failed for {os.path.basename(session.source)} "
                f"({failure}): {_tail(batch.log_path)}",
            )
        _segment_jobs.release()


def _start_batch(session: _Session, first_index: int, end_index: int) -> Optional[_Batch]:
    """Spawn a background batch. Caller must hold ``session.batch_lock``."""
    if session.info.has_video and not session.copy_video and not session.encoder_args:
        # A session created for the progressive path (or a test) never probed
        # for an encoder; pick one now so the batch has a real video encoder.
        session.encoder_name, session.encoder_args = _video_encoder()

    if not _segment_jobs.acquire(timeout=HLS_SEGMENT_WAIT):
        return None

    list_path = os.path.join(session.output_dir, "segments.csv")
    _remove_file(list_path)
    output_pattern = os.path.join(session.output_dir, "seg_%05d.ts")
    log_path = os.path.join(session.output_dir, "segment.log")
    cmd = _build_batch_command(session, first_index, end_index, list_path, output_pattern)

    try:
        log_handle = open(log_path, "wb")
        process = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=log_handle,
        )
    except OSError as exc:
        _segment_jobs.release()
        logger.log("warning", f"Could not start playback batch: {exc}")
        return None

    now = time.monotonic()
    batch = _Batch(
        process=process,
        first_index=first_index,
        end_index=end_index,
        log_handle=log_handle,
        log_path=log_path,
        started_at=now,
        last_segment_at=now,
    )
    with session.condition:
        session.batch = batch

    threading.Thread(
        target=_read_batch_progress,
        args=(session, batch),
        daemon=True,
        name="playback-batch-progress",
    ).start()
    watcher = threading.Thread(
        target=_watch_batch,
        args=(session, batch, list_path),
        daemon=True,
        name="playback-batch",
    )
    batch.thread = watcher
    watcher.start()

    logger.log(
        "info",
        f"Playback batch started for {os.path.basename(session.source)}: "
        f"segments {first_index}..{end_index - 1}",
    )
    return batch


def _stop_batch(session: _Session) -> None:
    """Kill the running batch (if any) and wait for its watcher to finish."""
    with session.batch_lock:
        with session.condition:
            batch = session.batch
        if batch is None:
            return
        batch.stopped = True
        _kill_process(batch.process)
        if batch.thread is not None and batch.thread is not threading.current_thread():
            batch.thread.join(timeout=10)
        with session.condition:
            if session.batch is batch:
                session.batch = None
            session.condition.notify_all()


def _clean_partial_segments(session: _Session) -> None:
    """Delete segment files that were never published (killed mid-write)."""
    with session.condition:
        completed = set(session.completed)
    try:
        names = os.listdir(session.output_dir)
    except OSError:
        return
    for name in names:
        match = _SEGMENT_RE.match(name)
        if match and int(match.group(1)) not in completed:
            _remove_file(os.path.join(session.output_dir, name))


def _generate_audio_segment(session: _Session, index: int) -> Optional[str]:
    """Audio-only sources: one cheap ffmpeg per segment.

    A batch would have no keyframes to cut on, and audio encoding is fast
    enough that the per-segment seek does not matter.
    """
    with session.batch_lock:
        path = _segment_path(session, index)
        if os.path.isfile(path) and os.path.getsize(path) > 0:
            session.completed.add(index)
            return path

        info = session.info
        lengths = session.segment_lengths
        start = sum(lengths[:index])
        length = lengths[index]
        partial = f"{path}.{os.getpid()}.{threading.get_ident()}.part"
        _remove_file(partial)
        cmd = [
            "ffmpeg", "-hide_banner", "-nostdin", "-y",
            "-ss", f"{start:.6f}",
            "-t", f"{length:.6f}",
            "-i", session.source,
            "-map", f"0:{info.audio_index}",
            "-c:a", "aac", "-b:a", HLS_AUDIO_BITRATE, "-ac", "2",
            "-af", f"asetpts=PTS-STARTPTS+{start:.6f}/TB",
            "-muxdelay", "0", "-muxpreload", "0",
            "-f", "mpegts",
            partial,
        ]
        log_path = os.path.join(session.output_dir, "segment.log")
        try:
            with open(log_path, "wb") as log_handle:
                result = subprocess.run(
                    cmd,
                    stdin=subprocess.DEVNULL,
                    stdout=log_handle,
                    stderr=subprocess.STDOUT,
                    timeout=HLS_SEGMENT_TIMEOUT,
                )
        except subprocess.TimeoutExpired:
            _remove_file(partial)
            logger.log("warning", f"Timed out transcoding audio segment {index}")
            return None
        except OSError as exc:
            _remove_file(partial)
            logger.log("warning", f"Could not transcode audio segment {index}: {exc}")
            return None

        if result.returncode != 0 or not os.path.isfile(partial) or os.path.getsize(partial) == 0:
            _remove_file(partial)
            logger.log("warning", f"ffmpeg failed on audio segment {index}: {_tail(log_path)}")
            return None

        os.replace(partial, path)
        session.completed.add(index)
        session.last_access = time.time()
        return path


def _generate_video_fallback_segment(session: _Session, index: int) -> Optional[str]:
    """Regenerate one failed original-copy segment with a real video encode.

    Stream copy is still the fast path; this function is only reached when the
    copy output was missing video, started on the wrong keyframe, or had a PTS
    hole. The resulting segment keeps the same absolute timeline and resolution
    so it can sit in the original-quality playlist without changing the level.
    """
    path = _segment_path(session, index)
    if _segment_ok(session, index) or (
        os.path.isfile(path) and os.path.getsize(path) > 0
    ):
        with session.condition:
            session.completed.add(index)
        return path

    # Keep the same lock order as _ensure_batch (_batch_lock then the job
    # semaphore) so a fallback and a new batch cannot deadlock each other.
    with session.batch_lock:
        if _segment_ok(session, index) or (
            os.path.isfile(path) and os.path.getsize(path) > 0
        ):
            with session.condition:
                session.completed.add(index)
            return path

        if not session.encoder_args:
            session.encoder_name, session.encoder_args = _video_encoder()
        if not session.encoder_args:
            logger.log(
                "warning",
                f"Cannot transcode fallback segment {index}: no video encoder",
            )
            return None

        if not _segment_jobs.acquire(timeout=HLS_SEGMENT_WAIT):
            return None

        try:
            info = session.info
            lengths = session.segment_lengths
            start = sum(lengths[:index])
            length = lengths[index]
            partial = f"{path}.{os.getpid()}.{threading.get_ident()}.part"
            _remove_file(partial)

            cmd = [
                "ffmpeg", "-hide_banner", "-nostdin", "-y",
                "-ss", f"{start:.6f}",
                "-t", f"{length:.6f}",
                "-i", session.source,
                "-map", f"0:{info.video_index}",
                *session.encoder_args,
            ]
            video_filter = _video_filter(info, session.target_height)
            if video_filter:
                cmd += ["-vf", video_filter]
            cmd += [
                "-an", "-sn", "-dn",
                "-muxdelay", "0", "-muxpreload", "0",
                "-output_ts_offset", f"{start:.6f}",
                "-f", "mpegts",
                partial,
            ]

            log_path = os.path.join(
                session.output_dir, f"fallback_{index:05d}.log"
            )
            try:
                with open(log_path, "wb") as log_handle:
                    result = subprocess.run(
                        cmd,
                        stdin=subprocess.DEVNULL,
                        stdout=log_handle,
                        stderr=subprocess.STDOUT,
                        timeout=HLS_SEGMENT_TIMEOUT,
                    )
            except subprocess.TimeoutExpired:
                _remove_file(partial)
                logger.log(
                    "warning",
                    f"Timed out transcoding fallback segment {index}",
                )
                return None
            except OSError as exc:
                _remove_file(partial)
                logger.log(
                    "warning",
                    f"Could not transcode fallback segment {index}: {exc}",
                )
                return None

            if (
                result.returncode != 0
                or not os.path.isfile(partial)
                or os.path.getsize(partial) == 0
            ):
                _remove_file(partial)
                logger.log(
                    "warning",
                    f"ffmpeg failed on fallback segment {index}: "
                    f"{_tail(log_path)}",
                )
                return None

            try:
                os.replace(partial, path)
            except OSError as exc:
                _remove_file(partial)
                logger.log(
                    "warning",
                    f"Could not publish fallback segment {index}: {exc}",
                )
                return None

            with session.condition:
                session.completed.add(index)
                session.condition.notify_all()
            session.last_access = time.time()
            logger.log(
                "info",
                f"Published transcoded fallback for original segment {index} "
                f"of {os.path.basename(session.source)}",
            )
            return path
        finally:
            _segment_jobs.release()


def _generate_audio_track_segment(
    session: _Session, track: int, index: int
) -> Optional[str]:
    """Produce one audio-only TS segment for a shared audio rendition.

    Unlike video, audio has no keyframes, so a cheap seek+encode per segment is
    both simpler and fast enough. Timestamps are placed on the absolute media
    timeline (``asetpts``) so hls.js can swap renditions at any position.
    """
    tracks = session.info.audio_streams
    if not tracks or track < 0 or track >= len(tracks):
        return None

    path = _audio_segment_path(session, track, index)
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        return path

    if not _audio_jobs.acquire(timeout=HLS_SEGMENT_WAIT):
        return None
    try:
        if os.path.isfile(path) and os.path.getsize(path) > 0:
            return path

        lengths = session.segment_lengths
        start = sum(lengths[:index])
        length = lengths[index]
        partial = f"{path}.{os.getpid()}.{threading.get_ident()}.part"
        _remove_file(partial)
        source = tracks[track]
        cmd = [
            "ffmpeg", "-hide_banner", "-nostdin", "-y",
            "-ss", f"{start:.6f}",
            "-t", f"{length:.6f}",
            "-i", session.source,
            "-map", f"0:{source.index}",
            "-vn", "-sn", "-dn",
            "-c:a", "aac", "-b:a", HLS_AUDIO_BITRATE, "-ac", "2",
            "-af", f"asetpts=PTS-STARTPTS+{start:.6f}/TB",
            "-muxdelay", "0", "-muxpreload", "0",
            "-f", "mpegts",
            partial,
        ]
        log_path = os.path.join(session.output_dir, f"audio_{track}.log")
        try:
            with open(log_path, "wb") as log_handle:
                result = subprocess.run(
                    cmd,
                    stdin=subprocess.DEVNULL,
                    stdout=log_handle,
                    stderr=subprocess.STDOUT,
                    timeout=HLS_SEGMENT_TIMEOUT,
                )
        except subprocess.TimeoutExpired:
            _remove_file(partial)
            logger.log("warning", f"Timed out transcoding audio track {track} segment {index}")
            return None
        except OSError as exc:
            _remove_file(partial)
            logger.log("warning", f"Could not transcode audio track {track} segment {index}: {exc}")
            return None

        if result.returncode != 0 or not os.path.isfile(partial) or os.path.getsize(partial) == 0:
            _remove_file(partial)
            logger.log(
                "warning",
                f"ffmpeg failed on audio track {track} segment {index}: {_tail(log_path)}",
            )
            return None

        os.replace(partial, path)
        session.last_access = time.time()
        return path
    finally:
        _audio_jobs.release()


# ── Batch scheduling ──────────────────────────────────────────────────────────


def _batch_covers(batch: _Batch, index: int) -> bool:
    """True when waiting on this batch is better than restarting it.

    Requests up to one batch-length past the batch end keep waiting: hls.js
    pipelines a few segments ahead, and killing a batch that is about to reach
    them would waste more work than letting it finish and starting the next
    batch at the requested segment.
    """
    return batch.first_index <= index < batch.end_index + HLS_BATCH_SEGMENTS


def _ensure_batch(session: _Session, index: int) -> bool:
    """Guarantee that a batch producing ``index`` is (being) started."""
    with session.batch_lock:
        if _segment_ok(session, index):
            return True

        with session.condition:
            if index in session.fallback_segments:
                # The copy batch must not overwrite a segment that is going to
                # be regenerated by the transcode fallback path.
                return True
            batch = session.batch
        if batch is not None and batch.process.poll() is None and _batch_covers(batch, index):
            return True

        _stop_batch(session)
        _clean_partial_segments(session)

        with session.condition:
            if index in session.completed and not _segment_ok(session, index):
                # A killed batch claimed a file that is gone; forget it.
                session.completed.discard(index)

        # Back off from a source that consistently fails to produce anything.
        if session.batch_failures >= 3:
            if time.monotonic() - session.last_batch_failure < 60:
                return False
            session.batch_failures = 0

        end_index = min(index + HLS_BATCH_SEGMENTS, session.segment_count)
        with session.condition:
            for candidate in range(index + 1, end_index):
                if candidate in session.completed:
                    if _segment_ok(session, candidate):
                        # Never overwrite an artifact a player may be reading.
                        end_index = candidate
                    else:
                        session.completed.discard(candidate)
                    break

        batch = _start_batch(session, index, end_index)
        return batch is not None


def get_segment_path(
    download_id: str,
    file_index: int,
    segment: str,
    caps_raw: Optional[str] = None,
    quality: Optional[str] = None,
) -> Optional[str]:
    """Resolve one segment, producing it on demand; reject anything else."""
    audio_match = _AUDIO_SEGMENT_RE.match(segment)
    match = _SEGMENT_RE.match(segment)
    if not audio_match and not match:
        return None

    # Audio renditions are shared across video qualities, so they always live
    # in the auto session.
    requested_quality = QUALITY_AUTO if audio_match else quality
    session = _ensure_session(
        download_id,
        file_index,
        caps_raw,
        start=False,
        quality=requested_quality,
    )
    if session is None:
        return None

    if audio_match:
        track = int(audio_match.group(1))
        index = int(audio_match.group(2))
        if index >= session.segment_count:
            return None
        session.last_access = time.time()
        return _generate_audio_track_segment(session, track, index)

    index = int(match.group(1))  # type: ignore[union-attr]
    # HLS is a delivery fallback, not just the preferred mode: a browser that
    # rejects the progressive MP4 can still ask for transcoded segments.
    if index >= session.segment_count:
        return None
    session.last_access = time.time()

    if _segment_ok(session, index):
        return _segment_path(session, index)

    if not session.info.has_video:
        return _generate_audio_segment(session, index)

    with session.condition:
        fallback = index in session.fallback_segments
    if fallback:
        return _generate_video_fallback_segment(session, index)

    deadline = time.monotonic() + HLS_SEGMENT_WAIT
    while True:
        if _segment_ok(session, index):
            return _segment_path(session, index)

        with session.condition:
            fallback = index in session.fallback_segments
        if fallback:
            return _generate_video_fallback_segment(session, index)

        if not _ensure_batch(session, index):
            return None

        with session.condition:
            if index in session.fallback_segments:
                continue
            remaining = deadline - time.monotonic()
            if remaining > 0:
                session.condition.wait(min(remaining, 1.0))

        if _segment_ok(session, index):
            return _segment_path(session, index)
        if time.monotonic() >= deadline:
            return None


# ── Session lifecycle ─────────────────────────────────────────────────────────


def _terminate(session: _Session) -> None:
    """Stop any running ffmpeg job and remove the session's workspace."""
    process = session.process
    if process is not None and process.poll() is None:
        _kill_process(process)
    session.process = None
    _stop_batch(session)
    shutil.rmtree(session.output_dir, ignore_errors=True)


def _start_reaper() -> None:
    global _reaper_started
    if _reaper_started:
        return
    _reaper_started = True

    def _loop() -> None:
        while True:
            time.sleep(30)
            cutoff = time.time() - HLS_IDLE_TIMEOUT
            evicted: list[_Session] = []
            with _sessions_lock:
                for session in list(_sessions.values()):
                    if session.last_access >= cutoff:
                        continue
                    # A running remux is useful work — let it finish even if
                    # the viewer closed the dialog.
                    if (
                        session.state == STATE_PREPARING
                        and session.process is not None
                        and session.process.poll() is None
                    ):
                        continue
                    # Never pull the rug out from under an active batch.
                    with session.condition:
                        batch = session.batch
                    if batch is not None and batch.process.poll() is None:
                        continue
                    _sessions.pop(session.key, None)
                    evicted.append(session)
            for session in evicted:
                _terminate(session)
            if evicted:
                logger.log("info", f"Removed {len(evicted)} idle playback session(s)")

    threading.Thread(target=_loop, daemon=True, name="playback-reaper").start()


def _ensure_session(
    download_id: str,
    file_index: int,
    caps_raw: Optional[str],
    *,
    start: bool,
    quality: Optional[str] = None,
) -> Optional[_Session]:
    """Return the shared session for one (file, capabilities, quality).

    ``quality="auto"`` is the default rendition used by the ticket, subtitles,
    thumbnails, and the shared HLS audio group. Explicit quality ids create
    independent HLS sessions so hls.js can switch video variants without
    re-encoding the other renditions. ``start`` kicks off the one-time remux
    for progressive auto sessions.
    """
    quality_id = _normalise_quality(quality)
    if quality_id is None:
        return None

    caps = parse_caps(caps_raw)
    key = (download_id, int(file_index), caps.key, quality_id)

    resolved = resolve_completed_file(download_id, int(file_index))
    if not resolved:
        return None
    source, _name = resolved

    signature = _source_signature(source)
    if signature is None:
        return None

    with _sessions_lock:
        existing = _sessions.get(key)
        if existing is not None and existing.source == source and existing.signature == signature:
            existing.last_access = time.time()
            if start:
                _start_progressive(existing)
            return existing
        if existing is not None:
            _terminate(existing)
            _sessions.pop(key, None)

        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            logger.log("error", "ffmpeg/ffprobe are not installed — cannot prepare playback")
            return None

        info = _probe(source)
        if info is None:
            logger.log("error", f"Cannot probe media for playback: {source}")
            return None

        target_height = _quality_target_height(info, quality_id)
        if quality_id != QUALITY_AUTO and target_height is None:
            return None
        if quality_id == QUALITY_ORIGINAL and not _can_copy_hls(info):
            return None

        mode = MODE_HLS if quality_id != QUALITY_AUTO else info.mode_for(caps)
        copy_video = quality_id == QUALITY_ORIGINAL

        if copy_video:
            lengths = _copy_segment_lengths(source, info)
            if lengths is None:
                logger.log(
                    "warning",
                    f"Cannot build a stream-copy rendition for {os.path.basename(source)} "
                    "(no source keyframes)",
                )
                return None
        else:
            lengths = _segment_lengths(info.duration or 0.0, info.frame_rate)

        encoder_name: Optional[str] = None
        encoder_args: tuple[str, ...] = ()
        if mode == MODE_HLS and info.has_video and not copy_video:
            encoder_name, encoder_args = _video_encoder()

        output_dir = os.path.join(
            playback_root(),
            download_id,
            str(int(file_index)),
            caps.key,
            quality_id,
        )
        shutil.rmtree(output_dir, ignore_errors=True)
        os.makedirs(output_dir, exist_ok=True)

        now = time.time()
        session = _Session(
            key=key,
            source=source,
            signature=signature,
            info=info,
            caps=caps,
            mode=mode,
            output_dir=output_dir,
            created_at=now,
            last_access=now,
            segment_lengths=lengths,
            quality=quality_id,
            target_height=target_height,
            copy_video=copy_video,
            encoder_name=encoder_name,
            encoder_args=encoder_args,
            state=STATE_READY if mode == MODE_HLS else STATE_IDLE,
        )
        _sessions[key] = session
        _start_reaper()
        logger.log(
            "info",
            f"Playback session ready ({mode}, quality={quality_id}, "
            f"video={info.video_codec or '-'}, audio={info.audio_codec or '-'}) "
            f"for {os.path.basename(source)}",
        )
        if start:
            _start_progressive(session)
        return session


# ── Public API (used by server.py) ────────────────────────────────────────────


def describe(
    download_id: str,
    file_index: int,
    caps_raw: Optional[str] = None,
) -> Optional[_Session]:
    """Probe a file and report how it would be played, without preparing it."""
    return _ensure_session(download_id, file_index, caps_raw, start=False)


def prepare(
    download_id: str,
    file_index: int,
    caps_raw: Optional[str] = None,
) -> Optional[_Session]:
    """Ensure playback is being prepared (idempotent)."""
    return _ensure_session(download_id, file_index, caps_raw, start=True)


def status_payload(session: _Session) -> dict:
    target = session.target_height if session.mode == MODE_HLS else None
    return {
        "mode": session.mode,
        "state": session.state,
        "progress": round(session.progress, 4),
        "detail": session.detail,
        "speed": round(session.speed, 3) if session.speed else None,
        "height": session.info.height,
        "targetHeight": target,
        "encoder": session.encoder_name if session.mode == MODE_HLS else None,
        "multiAudio": session.info.has_multiple_audio,
        "audioTracks": [
            {
                "index": ordinal,
                "streamIndex": track.index,
                "codec": track.codec,
                "channels": track.channels,
                "language": track.language,
                "title": track.title,
                "default": track.default,
            }
            for ordinal, track in enumerate(session.info.audio_streams)
        ],
        "subtitleTracks": [
            {
                "index": ordinal,
                "streamIndex": track.index,
                "codec": track.codec,
                "language": track.language,
                "title": track.title,
                "default": track.default,
                "forced": track.forced,
                "bitmap": track.bitmap,
            }
            for ordinal, track in enumerate(session.info.subtitle_streams)
        ],
        "chapters": [
            {"start": round(chapter.start, 3), "end": round(chapter.end, 3), "title": chapter.title}
            for chapter in session.info.chapters
        ],
    }


def get_playlist(
    download_id: str,
    file_index: int,
    caps_raw: Optional[str] = None,
    kind: str = "index",
    track: Optional[int] = None,
    quality: Optional[str] = None,
) -> Optional[str]:
    """Return a VOD playlist for a file (segments are produced on demand).

    ``kind="index"`` is always a master playlist for video sources, exposing
    the source-aware quality ladder and alternate audio. ``kind="video"`` and
    ``kind="audio"`` are the renditions referenced by that master. HLS is
    available for every session because it is also the client's final fallback.
    """
    # The master and its audio group always live in the auto session; only
    # video renditions carry an explicit quality id.
    requested_quality = QUALITY_AUTO if kind == "index" else quality
    session = _ensure_session(
        download_id, file_index, caps_raw, start=False, quality=requested_quality
    )
    if session is None:
        return None
    if not session.info.duration or session.info.duration <= 0:
        session.state = STATE_ERROR
        session.detail = "The worker could not determine this file's duration"
        logger.log(
            "warning",
            f"Cannot build a VOD playlist without a duration: {os.path.basename(session.source)}",
        )
        return None
    session.last_access = time.time()

    if kind == "index":
        if session.info.has_video:
            return _build_master_playlist(session)
        if session.info.has_multiple_audio:
            return _build_master_playlist(session)
        if session.info.audio_streams:
            return _build_audio_playlist(session, 0)
        return None
    if kind == "video":
        if not session.info.has_video:
            return None
        return _build_vod_playlist(session)
    if kind == "audio":
        if not session.info.audio_streams:
            return None
        if track is None or track < 0 or track >= len(session.info.audio_streams):
            return None
        return _build_audio_playlist(session, track)
    return None


def get_subtitle(
    download_id: str,
    file_index: int,
    track: int,
    caps_raw: Optional[str] = None,
) -> Optional[tuple[str, str]]:
    """Convert one embedded text subtitle stream to cached WebVTT.

    Returns ``(path, content_type)``. Bitmap subtitles (PGS/VobSub) cannot be
    rendered by a browser and return None.
    """
    session = _ensure_session(download_id, file_index, caps_raw, start=False)
    if session is None:
        return None
    tracks = session.info.subtitle_streams
    if track < 0 or track >= len(tracks):
        return None
    source_track = tracks[track]
    if source_track.bitmap:
        return None

    path = os.path.join(session.output_dir, f"sub_{track}.vtt")
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        session.last_access = time.time()
        return path, "text/vtt"

    partial = f"{path}.{os.getpid()}.{threading.get_ident()}.part"
    _remove_file(partial)
    cmd = [
        "ffmpeg", "-hide_banner", "-nostdin", "-y",
        "-i", session.source,
        "-map", f"0:{source_track.index}",
        "-vn", "-an", "-dn",
        "-c:s", "webvtt",
        "-f", "webvtt",
        partial,
    ]
    log_path = os.path.join(session.output_dir, f"sub_{track}.log")
    try:
        with open(log_path, "wb") as log_handle:
            result = subprocess.run(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                timeout=180,
            )
    except subprocess.TimeoutExpired:
        _remove_file(partial)
        logger.log("warning", f"Timed out extracting subtitle track {track}")
        return None
    except OSError as exc:
        _remove_file(partial)
        logger.log("warning", f"Could not extract subtitle track {track}: {exc}")
        return None

    if result.returncode != 0 or not os.path.isfile(partial) or os.path.getsize(partial) == 0:
        _remove_file(partial)
        logger.log(
            "warning",
            f"ffmpeg failed extracting subtitle track {track}: {_tail(log_path)}",
        )
        return None

    try:
        os.replace(partial, path)
    except OSError as exc:
        _remove_file(partial)
        logger.log("warning", f"Could not publish subtitle track {track}: {exc}")
        return None
    session.last_access = time.time()
    return path, "text/vtt"


def get_thumbnail(
    download_id: str,
    file_index: int,
    time_seconds: float,
    width: int = 320,
    caps_raw: Optional[str] = None,
) -> Optional[str]:
    """Generate (and cache) one JPEG preview frame for the seek bar."""
    session = _ensure_session(download_id, file_index, caps_raw, start=False)
    if session is None or not session.info.has_video:
        return None
    duration = session.info.duration or 0.0
    if duration <= 0:
        return None

    # Half-second buckets keep the cache small and avoid hammering ffmpeg while
    # the pointer moves across the bar. Stay away from the final frame: seeking
    # exactly to duration usually produces no frame at all.
    latest = max(0.0, duration - 0.5)
    moment = max(0.0, min(latest, float(time_seconds)))
    bucket = round(moment * 2) / 2
    safe_width = max(160, min(640, int(width or 320)))
    path = os.path.join(
        session.output_dir, f"thumb_{int(bucket * 10):06d}_{safe_width}.jpg"
    )
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        session.last_access = time.time()
        return path

    # Thumbnails are best-effort: if everything is busy, skip rather than queue.
    if not _thumbnail_jobs.acquire(blocking=False):
        return None
    try:
        if os.path.isfile(path) and os.path.getsize(path) > 0:
            return path
        partial = f"{path}.{os.getpid()}.{threading.get_ident()}.part.jpg"
        _remove_file(partial)
        cmd = [
            "ffmpeg", "-hide_banner", "-nostdin", "-y",
            "-ss", f"{bucket:.3f}",
            "-i", session.source,
            "-frames:v", "1",
            "-vf", f"scale={safe_width}:-2",
            "-q:v", "5",
            "-f", "image2",
            partial,
        ]
        try:
            result = subprocess.run(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            _remove_file(partial)
            return None
        if result.returncode != 0 or not os.path.isfile(partial) or os.path.getsize(partial) == 0:
            _remove_file(partial)
            return None
        try:
            os.replace(partial, path)
        except OSError:
            _remove_file(partial)
            return None
        session.last_access = time.time()
        return path
    finally:
        _thumbnail_jobs.release()


def get_media(
    download_id: str,
    file_index: int,
    caps_raw: Optional[str] = None,
) -> Optional[tuple[str, str]]:
    """Return (path, content_type) for a prepared progressive copy."""
    session = _ensure_session(download_id, file_index, caps_raw, start=False)
    if session is None or session.mode != MODE_PROGRESSIVE or session.state != STATE_READY:
        return None
    path = os.path.join(session.output_dir, _MP4_NAME)
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        return None
    session.last_access = time.time()
    content_type = "video/mp4" if session.info.has_video else "audio/mp4"
    return path, content_type


def shutdown() -> None:
    """Stop every playback job and remove the playback workspace."""
    with _sessions_lock:
        sessions = list(_sessions.values())
        _sessions.clear()
    for session in sessions:
        _terminate(session)
    shutil.rmtree(os.path.join(downloads_dir(), PLAYBACK_DIR_NAME), ignore_errors=True)


atexit.register(shutdown)
