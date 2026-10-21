"""Tests for streamlift_worker.streaming (Watch-page playback preparation).

Most tests use fake ffmpeg/ffprobe executables so the session/mode/playlist
logic is deterministic and needs no real media tools. A real-ffmpeg smoke test
is included for environments that have ffmpeg installed.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402

from streamlift_worker import local_files, streaming  # noqa: E402

ORIGINAL_PATH = os.environ.get("PATH", "")

FAKE_FFPROBE = """#!/usr/bin/env bash
set -e
last="${@: -1}"
if [[ "$last" == *.ts && "$*" == *"packet="* ]]; then
  # Stream-copy validation reads the packets of the freshly written segment.
  # Return a six-second GOP starting at that segment's absolute boundary.
  base="$(basename "$last")"
  digits="${base//[^0-9]/}"
  idx=$((10#${digits:-0}))
  start_ms=$((idx * 6000))
  printf '{"packets":['
  first=1
  for ms in 0 1000 2000 3000 4000 5000 5900; do
    total=$((start_ms + ms))
    if [[ $first -eq 1 ]]; then first=0; else printf ','; fi
    flags="___"
    if [[ $ms -eq 0 ]]; then flags="K__"; fi
    printf '{"stream_index":0,"pts_time":"%d.%03d","flags":"%s"}' \
      $((total / 1000)) $((total % 1000)) "$flags"
  done
  printf ']}\\n'
  exit 0
fi
if [[ "$*" == *"packet="* ]]; then
  # Keyframes at six-second boundaries; enough for the copy rendition tests.
  printf '{"packets":[{"stream_index":0,"pts_time":"0.000000","flags":"K__"},{"stream_index":0,"pts_time":"6.000000","flags":"K__"},{"stream_index":0,"pts_time":"12.000000","flags":"K__"},{"stream_index":0,"pts_time":"18.000000","flags":"K__"},{"stream_index":0,"pts_time":"24.000000","flags":"K__"}]}\\n'
  exit 0
fi
if [[ "$last" == *tail* ]]; then
  duration="30.5"
else
  duration="30.0"
fi
if [[ "$last" == *copy* ]]; then
  codec='{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"pix_fmt":"yuv420p","avg_frame_rate":"24/1","bit_rate":"8000000"},{"index":1,"codec_type":"audio","codec_name":"aac"}'
else
  codec='{"index":0,"codec_type":"video","codec_name":"hevc","width":3840,"height":2160,"pix_fmt":"yuv420p10le","avg_frame_rate":"24/1","bit_rate":"30000000"},{"index":1,"codec_type":"audio","codec_name":"ac3"}'
fi
printf '{"packets":[],"streams":[%s],"format":{"duration":"%s"}}\\n' "$codec" "$duration"
"""

FAKE_FFMPEG = """#!/usr/bin/env bash
set -e
args=("$@")
out="${args[$((${#args[@]}-1))]}"
if [[ "$out" == "-" ]]; then
  exit 0
fi
if [[ "$*" == *"-f segment"* ]]; then
  start=0
  list=""
  for ((i=0;i<${#args[@]};i++)); do
    if [[ "${args[$i]}" == "-segment_start_number" ]]; then start="${args[$((i+1))]}"; fi
    if [[ "${args[$i]}" == "-segment_list" ]]; then list="${args[$((i+1))]}"; fi
  done
  for ((k=0;k<3;k++)); do
    idx=$((start+k))
    f=$(printf "$out" "$idx")
    printf 'fake-segment' > "$f"
    if [[ -n "$list" ]]; then printf '%s,0.0,6.0\\n' "$(basename "$f")" >> "$list"; fi
  done
  printf 'out_time_us=1000000\\nspeed=2.5x\\nout_time_us=30000000\\nspeed=2.5x\\nprogress=end\\n'
  exit 0
fi
printf 'fake-media-bytes' > "$out"
case "$*" in
  *-progress*)
    printf 'out_time_us=1000000\\nspeed=1.5x\\nprogress=continue\\nout_time_us=30000000\\nspeed=1.5x\\nprogress=end\\n'
    ;;
esac
exit 0
"""


def _write_executable(path, content):
    path.write_text(content)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


@pytest.fixture(autouse=True)
def media_env(tmp_path, monkeypatch):
    """Sandbox the downloads root and put fake ffmpeg/ffprobe on PATH."""
    root = tmp_path / "streamlift-downloads"
    root.mkdir()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_executable(bin_dir / "ffmpeg", FAKE_FFMPEG)
    _write_executable(bin_dir / "ffprobe", FAKE_FFPROBE)

    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setattr(local_files, "downloads_dir", lambda: str(root))
    monkeypatch.setattr(streaming, "downloads_dir", lambda: str(root))
    streaming._sessions.clear()
    streaming._probe_cache.clear()

    yield root

    streaming.shutdown()


def _add_media(root, download_id, name):
    folder = root / download_id
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_bytes(b"source-media")
    local_files.record_completed_files(download_id, [str(path)])
    return path


def _wait_ready(session, timeout=5.0):
    deadline = time.time() + timeout
    while session.state == "preparing" and time.time() < deadline:
        time.sleep(0.02)
    return session


# ── Command/playlist helpers ─────────────────────────────────────────────────


def test_progress_seconds_parsing():
    assert streaming._progress_seconds("out_time_us=1500000") == 1.5
    # ffmpeg reports out_time_ms in microseconds too.
    assert streaming._progress_seconds("out_time_ms=29999977") == pytest.approx(29.999977)
    assert streaming._progress_seconds("out_time=00:01:02.500000") == 62.5
    assert streaming._progress_seconds("frame=10") is None
    assert streaming._progress_seconds("out_time=bogus") is None


def test_segment_lengths_are_contiguous():
    assert streaming._segment_lengths(30.0) == [6.0] * 5
    assert sum(streaming._segment_lengths(30.0)) == pytest.approx(30.0)
    # A tiny trailing remainder is folded into the previous segment.
    lengths = streaming._segment_lengths(30.5)
    assert lengths == [6.0, 6.0, 6.0, 6.0, 6.5]
    assert sum(lengths) == pytest.approx(30.5)
    # Long films stay exact.
    lengths = streaming._segment_lengths(5400.0)
    assert len(lengths) == 900
    assert sum(lengths) == pytest.approx(5400.0)


def test_segment_lengths_align_to_frame_rate():
    # 23.976fps: 6s rounds to 144 frames (6.006s), so forced keyframes land
    # exactly on segment boundaries instead of drifting off them.
    fps = 24000 / 1001
    lengths = streaming._segment_lengths(30.0, fps)
    assert lengths[0] == pytest.approx(144 / fps)
    assert sum(lengths) == pytest.approx(30.0)
    # 24fps stays exactly 6.0.
    assert streaming._segment_lengths(30.0, 24.0) == [6.0] * 5


def test_parse_caps_normalises_and_filters():
    caps = streaming.parse_caps(" HEVC,AV1,wat | AAC,ac3,unknown ")
    assert caps.video == frozenset({"hevc", "av1"})
    assert caps.audio == frozenset({"aac", "ac3"})
    # A missing/blank value means an older client: conservative default.
    assert streaming.parse_caps(None) is streaming.DEFAULT_CAPS
    assert streaming.parse_caps("") is streaming.DEFAULT_CAPS
    # Order must not matter — the session key and artifact dir hash this.
    assert (
        streaming.parse_caps("h264,hevc|aac,mp3").key
        == streaming.parse_caps("hevc,h264|mp3,aac").key
    )


# ── Progressive mode ─────────────────────────────────────────────────────────


def test_copy_safe_file_uses_progressive_mp4(media_env):
    _add_media(media_env, "copy1", "movie.mkv")

    session = streaming.describe("copy1", 0)
    assert session is not None
    assert session.mode == streaming.MODE_PROGRESSIVE
    assert session.state == streaming.STATE_IDLE
    assert streaming.get_media("copy1", 0) is None

    streaming.prepare("copy1", 0)
    _wait_ready(session)
    assert session.state == streaming.STATE_READY, session.detail
    assert session.progress == 1.0

    prepared = streaming.get_media("copy1", 0)
    assert prepared is not None
    path, content_type = prepared
    assert content_type == "video/mp4"
    assert os.path.isfile(path)
    assert os.path.getsize(path) > 0

    payload = streaming.status_payload(session)
    assert payload == {
        "mode": "progressive",
        "state": "ready",
        "progress": 1.0,
        "detail": None,
        "speed": None,
        "height": 1080,
        "targetHeight": None,
        "encoder": None,
        "multiAudio": False,
        "audioTracks": [
            {
                "index": 0,
                "streamIndex": 1,
                "codec": "aac",
                "channels": None,
                "language": None,
                "title": None,
                "default": False,
            }
        ],
        "subtitleTracks": [],
        "chapters": [],
    }

    # Preparing again is a no-op (same artifact).
    streaming.prepare("copy1", 0)
    assert session.state == streaming.STATE_READY


def test_progressive_session_can_fall_back_to_hls(media_env):
    """HLS must work even when the preferred mode is the progressive MP4."""
    _add_media(media_env, "fallback1", "movie-copy.mkv")

    session = streaming.describe("fallback1", 0)
    assert session is not None
    assert session.mode == streaming.MODE_PROGRESSIVE
    # Progressive sessions intentionally start without an encoder.
    assert session.encoder_args == ()

    master = streaming.get_playlist("fallback1", 0)
    assert master is not None
    assert "#EXT-X-STREAM-INF" in master
    assert "q=original" in master

    playlist = streaming.get_playlist("fallback1", 0, kind="video")
    assert playlist is not None
    assert "#EXT-X-PLAYLIST-TYPE:VOD" in playlist
    assert "#EXT-X-ENDLIST" in playlist

    path = streaming.get_segment_path("fallback1", 0, "seg_00000.ts")
    assert path is not None
    assert os.path.isfile(path)
    assert os.path.getsize(path) > 0
    # The batch selected an encoder lazily for the fallback.
    assert session.encoder_name


def test_original_copy_segment_validation_accepts_healthy_gop(media_env):
    _add_media(media_env, "validate1", "movie-copy.mkv")
    session = streaming._ensure_session(
        "validate1", 0, None, start=False, quality="original"
    )
    assert session is not None
    assert session.copy_video is True

    segment = os.path.join(session.output_dir, "seg_00000.ts")
    with open(segment, "wb") as handle:
        handle.write(b"fake-segment")

    valid, reason = streaming._validate_copy_segment(session, 0, segment)
    assert valid, reason


def test_healthy_original_segment_is_served_without_fallback(media_env):
    _add_media(media_env, "originalserve", "movie-copy.mkv")

    path = streaming.get_segment_path(
        "originalserve", 0, "seg_00000.ts", quality="original"
    )
    assert path is not None
    assert os.path.isfile(path)

    session = streaming._sessions[
        ("originalserve", 0, streaming.parse_caps(None).key, "original")
    ]
    assert session.copy_video is True
    assert 0 in session.completed
    assert not session.fallback_segments


def test_original_copy_segment_validation_rejects_no_video(
    media_env, monkeypatch, tmp_path
):
    _add_media(media_env, "validate2", "movie-copy.mkv")
    session = streaming._ensure_session(
        "validate2", 0, None, start=False, quality="original"
    )
    assert session is not None

    bad_bin = tmp_path / "badbin"
    bad_bin.mkdir()
    _write_executable(
        bad_bin / "ffprobe",
        "#!/usr/bin/env bash\nprintf '{\"packets\":[]}\\n'\n",
    )
    monkeypatch.setenv("PATH", f"{bad_bin}{os.pathsep}{os.environ.get('PATH', '')}")

    segment = os.path.join(session.output_dir, "seg_00000.ts")
    with open(segment, "wb") as handle:
        handle.write(b"bad-segment")

    valid, reason = streaming._validate_copy_segment(session, 0, segment)
    assert valid is False
    assert "no video packets" in reason


def test_original_copy_segment_validation_rejects_pts_gap(
    media_env, monkeypatch, tmp_path
):
    _add_media(media_env, "validate3", "movie-copy.mkv")
    session = streaming._ensure_session(
        "validate3", 0, None, start=False, quality="original"
    )
    assert session is not None

    bad_bin = tmp_path / "gapbin"
    bad_bin.mkdir()
    _write_executable(
        bad_bin / "ffprobe",
        "#!/usr/bin/env bash\n"
        "printf '{\"packets\":["
        "{\"pts_time\":\"0.000\",\"flags\":\"K__\"},"
        "{\"pts_time\":\"2.500\",\"flags\":\"___\"},"
        "{\"pts_time\":\"5.900\",\"flags\":\"___\"}"
        "]}\\n'\n",
    )
    monkeypatch.setenv("PATH", f"{bad_bin}{os.pathsep}{os.environ.get('PATH', '')}")

    segment = os.path.join(session.output_dir, "seg_00000.ts")
    with open(segment, "wb") as handle:
        handle.write(b"gappy-segment")

    valid, reason = streaming._validate_copy_segment(session, 0, segment)
    assert valid is False
    assert "timestamp gap" in reason


def test_failed_original_segment_is_transcoded_on_demand(media_env, monkeypatch):
    _add_media(media_env, "fallbackcopy", "movie-copy.mkv")
    monkeypatch.setattr(
        streaming,
        "_validate_copy_segment",
        lambda session, index, path: (False, "forced validation failure"),
    )

    path = streaming.get_segment_path(
        "fallbackcopy", 0, "seg_00000.ts", quality="original"
    )
    assert path is not None
    assert os.path.isfile(path)
    assert os.path.getsize(path) > 0

    session = streaming._sessions[
        ("fallbackcopy", 0, streaming.parse_caps(None).key, "original")
    ]
    assert 0 in session.fallback_segments
    assert 0 in session.completed
    assert session.copy_validation_failures >= 1
    assert session.encoder_args


def test_audio_only_copy_file_is_served_as_audio(media_env, monkeypatch):
    monkeypatch.setattr(streaming, "_probe", lambda path: streaming.ProbeInfo(
        video_index=None, audio_index=0, video_codec=None,
        audio_codec="aac", duration=12.0,
    ))
    _add_media(media_env, "audio1", "song.m4a")

    session = streaming.prepare("audio1", 0)
    assert session is not None
    _wait_ready(session)
    prepared = streaming.get_media("audio1", 0)
    assert prepared is not None
    assert prepared[1] == "audio/mp4"


def test_progressive_failure_surfaces_error(tmp_path, media_env, monkeypatch):
    _add_media(media_env, "bad1", "broken.mkv")

    failing = tmp_path / "bin-fail"
    failing.mkdir()
    _write_executable(failing / "ffmpeg", "#!/usr/bin/env bash\nexit 1\n")
    _write_executable(failing / "ffprobe", FAKE_FFPROBE)
    monkeypatch.setenv("PATH", f"{failing}{os.pathsep}{os.environ.get('PATH', '')}")
    # The probe is cached with the file's signature; force a fresh probe path.
    monkeypatch.setattr(streaming, "_probe", lambda path: streaming.ProbeInfo(
        video_index=0, audio_index=1, video_codec="h264",
        audio_codec="aac", duration=10.0,
    ))

    session = streaming.prepare("bad1", 0)
    assert session is not None
    _wait_ready(session)
    assert session.state == streaming.STATE_ERROR
    assert session.detail
    assert streaming.get_media("bad1", 0) is None


def test_mixed_copy_transcodes_only_audio(media_env, monkeypatch):
    """H.264 + AC3 must not re-encode the video (the old slow path)."""
    monkeypatch.setattr(streaming, "_probe", lambda path: streaming.ProbeInfo(
        video_index=0, audio_index=1, video_codec="h264",
        audio_codec="ac3", duration=12.0, height=1080,
        pix_fmt="yuv420p", frame_rate=24.0,
    ))
    _add_media(media_env, "mixed1", "movie.mkv")

    session = streaming.describe("mixed1", 0)
    assert session is not None
    assert session.mode == streaming.MODE_PROGRESSIVE

    command = streaming._build_progressive_command(session, "/tmp/out.mp4")
    assert command[command.index("-c:v") + 1] == "copy"
    assert command[command.index("-c:a") + 1] == "aac"


def test_client_that_supports_ac3_copies_it(media_env, monkeypatch):
    monkeypatch.setattr(streaming, "_probe", lambda path: streaming.ProbeInfo(
        video_index=0, audio_index=1, video_codec="h264",
        audio_codec="ac3", duration=12.0, height=1080,
        pix_fmt="yuv420p", frame_rate=24.0,
    ))
    _add_media(media_env, "mixed2", "movie.mkv")

    session = streaming.describe("mixed2", 0, "h264|aac,ac3")
    assert session is not None
    command = streaming._build_progressive_command(session, "/tmp/out.mp4")
    assert command[command.index("-c:a") + 1] == "copy"


def test_hevc_copy_depends_on_client_caps(media_env, monkeypatch):
    monkeypatch.setattr(streaming, "_probe", lambda path: streaming.ProbeInfo(
        video_index=0, audio_index=1, video_codec="hevc",
        audio_codec="aac", duration=12.0, height=2160,
        pix_fmt="yuv420p", frame_rate=24.0,
    ))
    _add_media(media_env, "hevc1", "movie.mkv")

    # A default (H.264-only) client cannot copy HEVC: full HLS transcode.
    slow = streaming.describe("hevc1", 0)
    assert slow is not None and slow.mode == streaming.MODE_HLS

    # Safari-style client that reports HEVC keeps the cheap copy path.
    fast = streaming.describe("hevc1", 0, "hevc|aac")
    assert fast is not None and fast.mode == streaming.MODE_PROGRESSIVE
    command = streaming._build_progressive_command(fast, "/tmp/out.mp4")
    assert command[command.index("-c:v") + 1] == "copy"
    assert command[command.index("-tag:v") + 1] == "hvc1"


# ── Virtual VOD HLS mode ─────────────────────────────────────────────────────


def test_transcode_file_uses_complete_vod_playlist(media_env, monkeypatch):
    monkeypatch.setattr(streaming, "HLS_MAX_HEIGHT", 1080)
    _add_media(media_env, "hls1", "movie.mkv")

    session = streaming.describe("hls1", 0)
    assert session is not None
    assert session.mode == streaming.MODE_HLS
    assert session.state == streaming.STATE_READY
    assert streaming.get_media("hls1", 0) is None

    # The master carries the client's capabilities and quality ladder. HEVC
    # cannot be copied into MPEG-TS, so there is no 4K original variant here.
    master = streaming.get_playlist("hls1", 0, "h264|aac")
    assert master is not None
    assert "#EXT-X-STREAM-INF" in master
    assert "q=original" not in master
    assert "q=1080" in master
    assert "q=720" in master

    # Each quality has its own complete VOD playlist, and every segment URL
    # carries both the capability string and the quality id.
    playlist = streaming.get_playlist("hls1", 0, "h264|aac", kind="video", quality="1080")
    assert playlist is not None
    lines = playlist.splitlines()
    assert lines[0] == "#EXTM3U"
    assert "#EXT-X-PLAYLIST-TYPE:VOD" in lines
    assert "#EXT-X-INDEPENDENT-SEGMENTS" in lines
    assert lines[-1] == "#EXT-X-ENDLIST"
    assert "#EXT-X-TARGETDURATION:6" in lines

    segments = [line for line in lines if line.startswith("seg_")]
    assert segments == [
        f"seg_{index:05d}.ts?caps=h264%7Caac&q=1080" for index in range(5)
    ]
    assert "#EXTINF:6.000," in lines


def test_batch_command_places_run_on_absolute_timeline(media_env):
    _add_media(media_env, "batch1", "movie.mkv")
    session = streaming.describe("batch1", 0)
    assert session is not None and session.mode == streaming.MODE_HLS

    command = streaming._build_batch_command(
        session, 2, 5, "/tmp/list.csv", "/tmp/seg_%05d.ts"
    )
    # The run starts at 12s and reads the requested 18s (minus the boundary
    # frame); output_ts_offset restores the absolute media timestamps that the
    # segment muxer would otherwise normalise to zero.
    assert command[command.index("-ss") + 1] == "12.000000"
    assert command[command.index("-t") + 1] == "17.999000"
    assert command[command.index("-output_ts_offset") + 1] == "12.000000"
    assert command[command.index("-muxdelay") + 1] == "0"
    assert command[command.index("-segment_start_number") + 1] == "2"
    force = command[command.index("-force_key_frames") + 1]
    assert "*lt(n_forced,3)" in force
    # 4K source is downscaled to the playback cap; it is never upscaled.
    video_filter = command[command.index("-vf") + 1]
    assert video_filter.startswith("scale=-2:")


def test_batch_coverage_rule():
    """Requests inside the window wait; a far seek restarts the batch."""
    batch = streaming._Batch(
        process=None, first_index=10, end_index=20, log_handle=None,
        log_path="", started_at=0.0, last_segment_at=0.0,
    )
    assert streaming._batch_covers(batch, 10)
    assert streaming._batch_covers(batch, 19)
    # Up to one batch past the end: wait for the batch to finish (hls.js
    # pipelines ahead) instead of throwing away work.
    assert streaming._batch_covers(batch, 20)
    assert streaming._batch_covers(batch, 39)
    # Far ahead or backwards: preempt and restart at the requested segment.
    assert not streaming._batch_covers(batch, 40)
    assert not streaming._batch_covers(batch, 9)


def test_batch_command_never_upscales(media_env, monkeypatch):
    monkeypatch.setattr(streaming, "_probe", lambda path: streaming.ProbeInfo(
        video_index=0, audio_index=1, video_codec="hevc",
        audio_codec="ac3", duration=12.0, height=480,
        pix_fmt="yuv420p", frame_rate=24.0,
    ))
    _add_media(media_env, "batch2", "movie.mkv")
    session = streaming.describe("batch2", 0)
    assert session is not None
    command = streaming._build_batch_command(
        session, 0, 2, "/tmp/list.csv", "/tmp/seg_%05d.ts"
    )
    assert "-vf" not in command


def test_vod_playlist_folds_tiny_tail(media_env):
    _add_media(media_env, "hls-tail", "movie.mkv")
    playlist = streaming.get_playlist("hls-tail", 0, kind="video")
    assert playlist is not None
    assert "#EXTINF:6.500," in playlist
    assert "#EXT-X-TARGETDURATION:7" in playlist
    assert len([line for line in playlist.splitlines() if line.startswith("seg_")]) == 5


def test_unknown_duration_fails_cleanly(media_env, monkeypatch):
    _add_media(media_env, "nodur", "movie.mkv")
    monkeypatch.setattr(streaming, "_probe", lambda path: streaming.ProbeInfo(
        video_index=0, audio_index=1, video_codec="hevc",
        audio_codec="ac3", duration=None,
    ))
    assert streaming.get_playlist("nodur", 0) is None


def test_segment_generation_on_demand(media_env):
    _add_media(media_env, "hls2", "movie.mkv")
    streaming.get_playlist("hls2", 0)

    path = streaming.get_segment_path("hls2", 0, "seg_00000.ts")
    assert path is not None
    assert os.path.isfile(path)
    assert os.path.getsize(path) > 0
    first_stat = os.stat(path).st_mtime_ns

    # The generated file is reused instead of re-transcoded.
    again = streaming.get_segment_path("hls2", 0, "seg_00000.ts")
    assert again == path
    assert os.stat(path).st_mtime_ns == first_stat


def test_segment_validation_and_bounds(media_env):
    _add_media(media_env, "hls3", "movie.mkv")

    assert streaming.get_segment_path("hls3", 0, "../../movie.mkv") is None
    assert streaming.get_segment_path("hls3", 0, "seg_1.ts") is None
    assert streaming.get_segment_path("hls3", 0, "seg_99999.ts") is None
    assert streaming.get_segment_path("hls3", 0, "index.m3u8") is None
    assert streaming.get_segment_path("hls3", 5, "seg_00000.ts") is None
    assert streaming.get_segment_path("missing", 0, "seg_00000.ts") is None
    assert streaming.get_segment_path("hls3", -1, "seg_00000.ts") is None


def test_missing_file_has_no_session(media_env):
    assert streaming.describe("nope", 0) is None
    assert streaming.prepare("nope", 0) is None
    assert streaming.get_playlist("nope", 0) is None
    assert streaming.get_media("nope", 0) is None


def test_shutdown_removes_artifacts(media_env):
    _add_media(media_env, "hls4", "movie.mkv")
    streaming.get_segment_path("hls4", 0, "seg_00000.ts")

    root = media_env / ".playback"
    assert root.is_dir()
    streaming.shutdown()
    assert not root.exists()
    assert streaming._sessions == {}


def test_multi_audio_master_playlist_and_track_metadata(media_env, monkeypatch):
    info = streaming.ProbeInfo(
        video_index=0,
        audio_index=1,
        video_codec="h264",
        audio_codec="aac",
        duration=12.0,
        width=1920,
        height=1080,
        pix_fmt="yuv420p",
        frame_rate=24.0,
        audio_streams=[
            streaming.AudioTrack(1, "aac", 2, "eng", "English", True),
            streaming.AudioTrack(2, "ac3", 6, "jpn", "Japanese", False),
        ],
        subtitle_streams=[
            streaming.SubtitleTrack(3, "subrip", "eng", "English", True, False),
            streaming.SubtitleTrack(4, "hdmv_pgs_subtitle", "eng", "Signs", False, True),
        ],
        chapters=[
            streaming.Chapter(0.0, 6.0, "Intro"),
            streaming.Chapter(6.0, 12.0, "Main"),
        ],
    )
    monkeypatch.setattr(streaming, "_probe", lambda path: info)
    _add_media(media_env, "multi1", "movie.mkv")

    session = streaming.describe("multi1", 0)
    assert session is not None
    # Alternate audio renditions require HLS even when the video is copyable.
    assert session.mode == streaming.MODE_HLS

    master = streaming.get_playlist("multi1", 0, kind="index")
    assert master is not None
    assert master.count("#EXT-X-MEDIA:TYPE=AUDIO") == 2
    assert 'NAME="English"' in master
    assert 'NAME="Japanese"' in master
    assert 'DEFAULT=YES' in master
    assert 'URI="audio/1.m3u8' in master
    assert "video.m3u8" in master

    video = streaming.get_playlist("multi1", 0, kind="video")
    assert video is not None and "seg_00000.ts" in video

    audio = streaming.get_playlist("multi1", 0, kind="audio", track=1)
    assert audio is not None
    # The audio playlist is one directory below the shared segment directory.
    assert "../aud_1_00000.ts" in audio
    assert "aud_1_00001.ts" in audio
    assert streaming.get_playlist("multi1", 0, kind="audio", track=9) is None

    segment = streaming.get_segment_path("multi1", 0, "aud_1_00000.ts")
    assert segment is not None and os.path.isfile(segment)
    assert streaming.get_segment_path("multi1", 0, "aud_9_00000.ts") is None

    payload = streaming.status_payload(session)
    assert payload["multiAudio"] is True
    assert [track["title"] for track in payload["audioTracks"]] == [
        "English",
        "Japanese",
    ]
    assert [track["bitmap"] for track in payload["subtitleTracks"]] == [False, True]
    assert payload["chapters"] == [
        {"start": 0.0, "end": 6.0, "title": "Intro"},
        {"start": 6.0, "end": 12.0, "title": "Main"},
    ]


def test_quality_ladder_keeps_4k_original_and_caps_transcodes(monkeypatch):
    monkeypatch.setattr(streaming, "HLS_MAX_HEIGHT", 1080)
    info = streaming.ProbeInfo(
        video_index=0,
        audio_index=1,
        video_codec="h264",
        audio_codec="aac",
        duration=10.0,
        width=3840,
        height=2160,
        pix_fmt="yuv420p",
        frame_rate=24.0,
    )
    variants = streaming._quality_variants(info)
    assert [variant["quality"] for variant in variants] == [
        "original",
        "1080",
        "720",
        "480",
        "360",
    ]
    assert [variant["height"] for variant in variants] == [2160, 1080, 720, 480, 360]

    hevc = streaming.ProbeInfo(
        video_index=0,
        audio_index=1,
        video_codec="hevc",
        audio_codec="aac",
        duration=10.0,
        width=3840,
        height=2160,
        pix_fmt="yuv420p10le",
        frame_rate=24.0,
    )
    assert [variant["quality"] for variant in streaming._quality_variants(hevc)] == [
        "1080",
        "720",
        "480",
        "360",
    ]


def test_master_exposes_original_and_transcoded_qualities(media_env, monkeypatch):
    monkeypatch.setattr(streaming, "HLS_MAX_HEIGHT", 1080)
    _add_media(media_env, "quality1", "movie-copy.mkv")

    master = streaming.get_playlist("quality1", 0)
    assert master is not None
    assert "q=original" in master
    assert 'NAME="Original (1080p)"' in master
    assert "RESOLUTION=1920x1080" in master
    assert "q=720" in master
    assert "q=480" in master
    assert "q=360" in master
    # The original 1080p copy must not be duplicated as a 1080p transcode.
    assert "q=1080" not in master

    original = streaming.get_playlist("quality1", 0, kind="video", quality="original")
    assert original is not None
    assert "q=original" in original
    assert "seg_00000.ts?caps=" in original

    copy_session = streaming._sessions[
        ("quality1", 0, streaming.parse_caps(None).key, "original")
    ]
    assert copy_session.copy_video is True
    command = streaming._build_batch_command(
        copy_session, 0, 2, "/tmp/list.csv", "/tmp/seg_%05d.ts"
    )
    assert command[command.index("-c:v") + 1] == "copy"
    assert "-an" in command
    assert "-force_key_frames" not in command

    transcoded = streaming.get_playlist("quality1", 0, kind="video", quality="720")
    assert transcoded is not None
    transcode_session = streaming._sessions[
        ("quality1", 0, streaming.parse_caps(None).key, "720")
    ]
    transcode_command = streaming._build_batch_command(
        transcode_session, 0, 2, "/tmp/list.csv", "/tmp/seg_%05d.ts"
    )
    assert "copy" not in transcode_command
    assert "libx264" in transcode_command
    assert transcode_command[transcode_command.index("-vf") + 1] == "scale=-2:720"


def test_hevc_master_has_transcodes_but_no_original(media_env, monkeypatch):
    monkeypatch.setattr(streaming, "HLS_MAX_HEIGHT", 1080)
    _add_media(media_env, "quality2", "movie.mkv")

    master = streaming.get_playlist("quality2", 0)
    assert master is not None
    assert "q=original" not in master
    assert "q=1080" in master
    assert "q=720" in master
    assert "q=480" in master
    assert "q=360" in master

    # HEVC is not copy-safe for MPEG-TS HLS yet.
    assert streaming.get_playlist(
        "quality2", 0, kind="video", quality="original"
    ) is None
    assert streaming.get_playlist(
        "quality2", 0, kind="video", quality="9999"
    ) is None


def test_single_audio_quality_session_uses_shared_audio_rendition(media_env, monkeypatch):
    monkeypatch.setattr(streaming, "HLS_MAX_HEIGHT", 1080)
    _add_media(media_env, "quality3", "movie.mkv")

    master = streaming.get_playlist("quality3", 0)
    assert master is not None
    assert master.count("#EXT-X-MEDIA:TYPE=AUDIO") == 1
    assert 'URI="audio/0.m3u8' in master

    audio = streaming.get_playlist("quality3", 0, kind="audio", track=0)
    assert audio is not None
    assert "aud_0_00000.ts" in audio
    segment = streaming.get_segment_path("quality3", 0, "aud_0_00000.ts")
    assert segment is not None and os.path.isfile(segment)

    # Video renditions are audio-free; the shared audio group owns the audio.
    video = streaming.get_playlist(
        "quality3", 0, kind="video", quality="720"
    )
    assert video is not None
    session = streaming._sessions[
        ("quality3", 0, streaming.parse_caps(None).key, "720")
    ]
    command = streaming._build_batch_command(
        session, 0, 2, "/tmp/list.csv", "/tmp/seg_%05d.ts"
    )
    assert "-an" in command


def test_subtitle_extraction_serves_webvtt(media_env, monkeypatch):
    info = streaming.ProbeInfo(
        video_index=0,
        audio_index=1,
        video_codec="h264",
        audio_codec="aac",
        duration=12.0,
        subtitle_streams=[
            streaming.SubtitleTrack(2, "subrip", "eng", "English"),
        ],
    )
    monkeypatch.setattr(streaming, "_probe", lambda path: info)
    _add_media(media_env, "subs1", "movie.mkv")

    result = streaming.get_subtitle("subs1", 0, 0)
    assert result is not None
    path, media_type = result
    assert media_type == "text/vtt"
    assert os.path.isfile(path) and os.path.getsize(path) > 0
    # A second request is served from cache.
    assert streaming.get_subtitle("subs1", 0, 0) == result
    assert streaming.get_subtitle("subs1", 0, 1) is None


def test_thumbnail_generation(media_env, monkeypatch):
    info = streaming.ProbeInfo(
        video_index=0,
        audio_index=1,
        video_codec="h264",
        audio_codec="aac",
        duration=12.0,
        width=1920,
        height=1080,
    )
    monkeypatch.setattr(streaming, "_probe", lambda path: info)
    _add_media(media_env, "thumbs1", "movie.mkv")

    path = streaming.get_thumbnail("thumbs1", 0, 3.2, 320)
    assert path is not None
    assert path.endswith("_320.jpg")
    assert os.path.isfile(path) and os.path.getsize(path) > 0
    assert streaming.get_thumbnail("thumbs1", 0, 3.2, 320) == path
    # Clamped to the supported preview width.
    small = streaming.get_thumbnail("thumbs1", 0, 4.0, 20)
    assert small is not None and small.endswith("_160.jpg")


def test_watch_routes_forward_quality_parameter(monkeypatch, tmp_path):
    """HTTP layer must preserve ``q`` for playlists and segments."""
    from fastapi.testclient import TestClient

    from streamlift_worker import server

    calls: list[tuple] = []

    def fake_playlist(*args):
        calls.append(args)
        return "#EXTM3U\n#EXT-X-ENDLIST\n"

    segment_file = tmp_path / "seg_00000.ts"
    segment_file.write_bytes(b"segment")

    def fake_segment(*args):
        calls.append(args)
        return str(segment_file)

    monkeypatch.setattr(streaming, "get_playlist", fake_playlist)
    monkeypatch.setattr(streaming, "get_segment_path", fake_segment)
    client = TestClient(server.app)

    playlist = client.get(
        "/watch/abc/2/video.m3u8",
        params={"caps": "h264|aac", "q": "720"},
    )
    assert playlist.status_code == 200
    assert calls[-1] == ("abc", 2, "h264|aac", "video", None, "720")

    segment = client.get(
        "/watch/abc/2/seg_00000.ts",
        params={"caps": "h264|aac", "q": "original"},
    )
    assert segment.status_code == 200
    assert calls[-1] == ("abc", 2, "seg_00000.ts", "h264|aac", "original")


# ── Optional real-ffmpeg smoke test ─────────────────────────────────────────


@pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
    reason="ffmpeg/ffprobe not installed",
)
def test_real_ffmpeg_roundtrip(tmp_path, monkeypatch):
    # The shared fixture installs fake binaries; use the real ones here.
    monkeypatch.setenv("PATH", ORIGINAL_PATH)
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        pytest.skip("ffmpeg/ffprobe not installed")

    root = tmp_path / "real"
    root.mkdir()
    monkeypatch.setattr(local_files, "downloads_dir", lambda: str(root))
    monkeypatch.setattr(streaming, "downloads_dir", lambda: str(root))
    streaming._sessions.clear()
    streaming._probe_cache.clear()

    source = root / "clip.mkv"
    make = subprocess.run(
        [
            shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24:duration=12",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", str(source),
        ],
        capture_output=True,
    )
    assert make.returncode == 0, make.stderr
    local_files.record_completed_files("real1", [str(source)])

    session = streaming.prepare("real1", 0)
    assert session is not None
    assert session.mode == streaming.MODE_PROGRESSIVE
    _wait_ready(session, timeout=60)
    assert session.state == streaming.STATE_READY, session.detail
    prepared = streaming.get_media("real1", 0)
    assert prepared is not None
    assert os.path.getsize(prepared[0]) > 0

    # Force the HLS path: the video playlist must be complete VOD and the
    # first segment must be decodable with a keyframe at 0.
    session.mode = streaming.MODE_HLS
    playlist = streaming.get_playlist("real1", 0, kind="video")
    assert playlist is not None and playlist.rstrip().endswith("#EXT-X-ENDLIST")
    segment = streaming.get_segment_path("real1", 0, "seg_00000.ts")
    assert segment is not None
    probe = subprocess.run(
        [shutil.which("ffprobe"), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "packet=pts_time,flags", "-of", "json", segment],
        capture_output=True, text=True,
    )
    packets = json.loads(probe.stdout or "{}").get("packets", [])
    assert packets
    assert abs(float(packets[0]["pts_time"])) < 0.05
    assert "K" in packets[0]["flags"]

    # The second segment comes from the same batch and keeps the absolute
    # timeline (the segment muxer must not rebase it to zero).
    second = streaming.get_segment_path("real1", 0, "seg_00001.ts")
    assert second is not None
    probe = subprocess.run(
        [shutil.which("ffprobe"), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "packet=pts_time,flags", "-of", "json", second],
        capture_output=True, text=True,
    )
    packets = json.loads(probe.stdout or "{}").get("packets", [])
    assert packets
    assert abs(float(packets[0]["pts_time"]) - 6.0) < 0.05
    assert "K" in packets[0]["flags"]
