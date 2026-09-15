import os
import struct
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from streamlift_worker.aria2c_stream import (  # noqa: E402
    _PieceStream,
    _bitfield_complete_bytes,
    _bt_head_flag,
    _contiguous_complete_bytes,
    _file_type,
    _format_bytes,
    _info_hash_from_magnet,
    _metadata_phase,
    _parse_aria2_control,
    _parse_torrent_meta,
    _select_files,
)


# ── helpers to build test-fixture binaries ───────────────────────────────────


def _bencode(obj):
    if isinstance(obj, int):
        return b"i%de" % obj
    if isinstance(obj, str):
        obj = obj.encode("utf-8")
    if isinstance(obj, bytes):
        return b"%d:%s" % (len(obj), obj)
    if isinstance(obj, list):
        return b"l" + b"".join(_bencode(x) for x in obj) + b"e"
    return b"d" + b"".join(_bencode(k) + _bencode(v) for k, v in obj.items()) + b"e"


def _control_file(piece_len, total_len, bitfield, info_hash=b"\x11" * 20):
    parts = [struct.pack(">H", 1)]  # version
    parts.append(b"\x00" * 4)  # ext
    parts.append(struct.pack(">I", len(info_hash)))
    parts.append(info_hash)
    parts.append(struct.pack(">I", piece_len))
    parts.append(struct.pack(">Q", total_len))
    parts.append(b"\x00" * 8)  # upload length
    parts.append(struct.pack(">I", len(bitfield)))
    parts.append(bitfield)
    return b"".join(parts)


def _torrent_bytes(info):
    return _bencode({"info": info, "announce": "http://tracker.test/announce"})


# ── _PieceStream ─────────────────────────────────────────────────────────────


def test_piece_stream_single_read_exact():
    s = _PieceStream()
    s._push(b"abc")
    s._push(b"def")
    s._finish()
    assert s.read(6) == b"abcdef"


def test_piece_stream_blocks_until_enough_bytes():
    s = _PieceStream()

    def producer():
        time.sleep(0.05)
        s._push(b"aaaa")
        time.sleep(0.05)
        s._push(b"bbbb")
        s._finish()

    t = threading.Thread(target=producer)
    t.start()
    assert s.read(5) == b"aaaab"
    assert s.read(8) == b"bbb"
    t.join()


def test_piece_stream_eof_and_abort():
    s = _PieceStream()
    s._finish()
    assert s.read(10) == b""

    s2 = _PieceStream()
    s2._push(b"x")
    s2._abort()
    assert s2.read(10) == b""  # abort discards queued bytes for fast shutdown


# ── configurable head window ─────────────────────────────────────────────────


def test_bt_head_flag_default_and_env(monkeypatch):
    monkeypatch.delenv("STREAMLIFT_BT_HEAD", raising=False)
    assert _bt_head_flag() == "head=256M"
    monkeypatch.setenv("STREAMLIFT_BT_HEAD", "256M")
    assert _bt_head_flag() == "head=256M"
    monkeypatch.setenv("STREAMLIFT_BT_HEAD", "")
    assert _bt_head_flag() == "head=256M"


# ── aria2 .aria2 control file parsing ────────────────────────────────────────


def test_parse_aria2_control_roundtrip(tmp_path):
    path = tmp_path / "a.bin.aria2"
    path.write_bytes(_control_file(16_384, 81_920, b"\xc0" + b"\x00" * 4))
    piece_len, total_len, bitfield = _parse_aria2_control(str(path))
    assert (piece_len, total_len) == (16_384, 81_920)
    assert bitfield == b"\xc0" + b"\x00" * 4


def test_parse_aria2_control_rejects_bad_version(tmp_path):
    path = tmp_path / "x.aria2"
    blob = bytearray(_control_file(16_384, 81_920, b"\x00"))
    blob[0:2] = struct.pack(">H", 7)
    path.write_bytes(bytes(blob))
    import pytest

    with pytest.raises(ValueError, match="version"):
        _parse_aria2_control(str(path))


# ── contiguous prefix calculation ────────────────────────────────────────────


def test_contiguous_complete_bytes():
    pf = _contiguous_complete_bytes
    # MSB-first: b"\xc0" = pieces 0,1 complete
    assert pf(b"\xc0", 16_384, 81_920) == 32_768
    # gap at piece 1 → only piece 0 counts
    assert pf(b"\xa0", 16_384, 81_920) == 16_384
    # empty bitfield
    assert pf(b"\x00", 16_384, 81_920) == 0
    # short last piece clamps to the real file size
    assert pf(b"\xff", 16_384, 20_000) == 20_000
    # guards
    assert pf(b"\xff", 0, 20_000) == 0
    assert pf(b"\xff", 16_384, 0) == 0


def test_bitfield_complete_bytes():
    bf = _bitfield_complete_bytes
    # b"\xc0" = pieces 0,1 complete
    assert bf(b"\xc0", 16_384, 81_920) == 32_768
    # gap at piece 1 → both pieces still count (any order)
    assert bf(b"\xa0", 16_384, 81_920) == 32_768
    assert bf(b"\x00", 16_384, 81_920) == 0
    assert bf(b"\xff", 16_384, 20_000) == 20_000


# ── .torrent metadata parsing ────────────────────────────────────────────────


def test_parse_torrent_meta_single_file(tmp_path):
    blob = _torrent_bytes({"name": "hello.txt", "length": 1024, "piece length": 16_384})
    path = tmp_path / "x.torrent"
    path.write_bytes(blob)
    piece_len, files = _parse_torrent_meta(str(path))
    assert piece_len == 16_384
    assert files == [(0, "hello.txt", 1024, 0)]


def test_parse_torrent_meta_multi_file(tmp_path):
    info = {
        "name": "bundle",
        "piece length": 16_384,
        "files": [
            {"length": 1000, "path": ["a.txt"]},
            {"length": 500, "path": ["sub", "b.bin"]},
            {"length": 32, "path": [".pad", "223232"]},
        ],
    }
    blob = _torrent_bytes(info)
    path = tmp_path / "x.torrent"
    path.write_bytes(blob)
    piece_len, files = _parse_torrent_meta(str(path))
    assert piece_len == 16_384
    assert files == [
        (0, "a.txt", 1000, 0),
        (1, "sub/b.bin", 500, 1000),
        (2, ".pad/223232", 32, 1500),
    ]


def test_select_files():
    meta = [
        (0, "a.txt", 1000, 0),
        (1, "sub/b.bin", 500, 1000),
        (2, ".pad/223232", 32, 1500),
    ]
    # pads never selected
    assert [i for i, _, _, _ in _select_files(meta, None)] == [0, 1]
    assert [i for i, _, _, _ in _select_files(meta, [0, 1])] == [0, 1]
    # pad+invalid indices → fall back to all real files
    assert [i for i, _, _, _ in _select_files(meta, [1, 99])] == [0, 1]
    # only pad requested → fall back
    assert [i for i, _, _, _ in _select_files(meta, [2])] == [0, 1]


# ── downloader dispatch ──────────────────────────────────────────────────────


class _FakeApi:
    def __init__(self):
        self.updates = []

    def status_update(self, config, download_id, status, error=None, location_path=None, cloud_file_handle=None):
        self.updates.append((download_id, status, error, cloud_file_handle))


def _fake_stream(ok):
    def fake(config, download_id, magnet, indices, name, task, **_):
        task["progress"] = 100
        return ok

    return fake


def test_torrent_dispatch_streams_via_aria2c(monkeypatch):
    from streamlift_worker import downloader
    from streamlift_worker import aria2c_stream

    cfg = type("C", (), {"download_location": "mega"})()
    global_updates = _FakeApi()
    monkeypatch.setattr(downloader, "api", global_updates)
    received = {}

    def spy(config, download_id, magnet, indices, name, task, **_):
        received.update(download_id=download_id, indices=indices)
        return True

    monkeypatch.setattr(aria2c_stream, "stream_torrent_to_mega", spy)
    task = {"downloadId": "d1", "fileIndices": "[]",
            "sourceUrl": "magnet:?xt=urn:btih:aa", "displayName": "x"}
    current = {}

    downloader.process_torrent_download(cfg, task, current)

    assert received["download_id"] == "d1"
    assert received["indices"] is None  # empty selection string → all files
    assert current["status"] == "completed"
    assert global_updates.updates[-1] == ("d1", "completed", None, None)


def test_torrent_dispatch_falls_back_to_classic_aria2c(monkeypatch):
    from streamlift_worker import downloader
    from streamlift_worker import aria2c_stream

    cfg = type("C", (), {"download_location": "mega"})()
    global_updates = _FakeApi()
    monkeypatch.setattr(downloader, "api", global_updates)
    monkeypatch.setattr(aria2c_stream, "stream_torrent_to_mega", _fake_stream(False))
    monkeypatch.setattr(downloader, "_ensure_aria2c", lambda: False)
    task = {"downloadId": "d2", "sourceUrl": "magnet:?xt=urn:btih:aa", "displayName": "x"}
    current = {}

    downloader.process_torrent_download(cfg, task, current)

    assert global_updates.updates[-1][1] == "failed"
    assert current == {}  # failed path clears the current task


def test_torrent_dispatch_cancel_raises_upload_cancelled(monkeypatch):
    from streamlift_worker import downloader, mega
    from streamlift_worker import aria2c_stream

    cfg = type("C", (), {"download_location": "mega"})()
    global_updates = _FakeApi()
    monkeypatch.setattr(downloader, "api", global_updates)

    def cancel(config, download_id, magnet, indices, name, task, **_):
        raise mega.UploadCancelled("Cancelled by user")

    monkeypatch.setattr(aria2c_stream, "stream_torrent_to_mega", cancel)
    task = {"downloadId": "d3", "sourceUrl": "magnet:?xt=urn:btih:aa", "displayName": "x"}
    current = {}

    downloader.process_torrent_download(cfg, task, current)

    assert current["status"] == "failed"
    assert global_updates.updates[-1] == ("d3", "failed", "Cancelled by user", None)


# ── install-first ordering (fresh Colab: aria2c must be ensured before streaming) ──


def test_stream_installs_aria2c_before_starting(monkeypatch, tmp_path):
    from streamlift_worker import aria2c_stream, downloader, local_files

    calls = []
    monkeypatch.setattr(local_files, "downloads_dir", lambda: str(tmp_path))
    monkeypatch.setattr(
        downloader, "_ensure_aria2c",
        lambda: calls.append("ensure") or True,
    )
    monkeypatch.setattr(
        aria2c_stream, "_metadata_phase",
        lambda *a, **k: calls.append("metadata") or None,
    )

    cfg = type("C", (), {"download_location": "mega"})()
    ok = aria2c_stream.stream_torrent_to_mega(
        cfg, "d1", "magnet:?xt=urn:btih:aa", None, "x", {}
    )

    assert calls == ["ensure", "metadata"]  # install check ran BEFORE metadata phase
    assert ok is False  # metadata fetch returned None → classic fallback


def test_stream_returns_false_when_aria2c_cannot_be_installed(monkeypatch, tmp_path):
    from streamlift_worker import aria2c_stream, downloader, local_files

    calls = []
    monkeypatch.setattr(local_files, "downloads_dir", lambda: str(tmp_path))
    monkeypatch.setattr(downloader, "_ensure_aria2c", lambda: False)
    monkeypatch.setattr(
        aria2c_stream, "_metadata_phase",
        lambda *a, **k: calls.append("metadata") or None,
    )

    cfg = type("C", (), {"download_location": "mega"})()
    ok = aria2c_stream.stream_torrent_to_mega(
        cfg, "d2", "magnet:?xt=urn:btih:aa", None, "x", {}
    )

    assert ok is False
    assert calls == []  # metadata phase never ran without aria2c


# ── pure helpers for the metadata-fetch endpoint ────────────────────────────


def test_format_bytes():
    assert _format_bytes(0) == "0 Bytes"
    assert _format_bytes(1023) == "1023.00 Bytes"
    assert _format_bytes(1536) == "1.50 KB"
    assert _format_bytes(1_048_576) == "1.00 MB"
    assert _format_bytes(1_073_741_824) == "1.00 GB"


def test_file_type():
    assert _file_type("movie.mkv") == "video"
    assert _file_type("song.mp3") == "audio"
    assert _file_type("photo.jpg") == "image"
    assert _file_type("doc.pdf") == "document"
    assert _file_type("archive.zip") == "archive"
    assert _file_type("readme") == "other"


def test_info_hash_from_magnet():
    assert _info_hash_from_magnet("magnet:?xt=urn:btih:aaBBccDD112233445566778899AABBCCDD") == "aabbccdd112233445566778899aabbccdd"
    assert _info_hash_from_magnet("magnet:?xt=urn:btih:AA") == ""
    assert _info_hash_from_magnet("https://example.com/file.torrent") == ""


def test_fetch_torrent_metadata(monkeypatch, tmp_path):
    from streamlift_worker import aria2c_stream

    info = {
        "name": "Big.Bundle",
        "piece length": 16_384,
        "files": [
            {"length": 1_000_000, "path": ["video.mkv"]},
            {"length": 250_000, "path": ["subtitle.srt"]},
        ],
    }
    blob = _torrent_bytes(info)
    torrent_path = tmp_path / "Big.Bundle.torrent"
    torrent_path.write_bytes(blob)

    monkeypatch.setattr(aria2c_stream, "_metadata_phase", lambda *a, **kw: str(torrent_path))

    result = aria2c_stream.fetch_torrent_metadata(
        "magnet:?xt=urn:btih:aabbccdd112233445566778899aabbccdd",
        tracker="",
    )
    assert result is not None
    assert result["name"] == "Big.Bundle"
    assert result["infoHash"] == "aabbccdd112233445566778899aabbccdd"
    assert result["fileCount"] == 2
    assert result["totalSize"] == 1_250_000
    files = result["files"]
    assert [f["index"] for f in files] == [0, 1]
    assert files[0]["size"] >= files[1]["size"]  # sorted desc
    assert files[0]["name"] == "video.mkv"
    assert files[0]["type"] == "video"
    assert files[1]["name"] == "subtitle.srt"
    assert files[1]["type"] == "other"