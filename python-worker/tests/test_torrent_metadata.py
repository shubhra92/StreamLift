import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from streamlift_worker.torrent_metadata import (  # noqa: E402
    _bt_tracker_map,
    _file_type,
    _format_bytes,
    _info_hash_from_magnet,
    _parse_torrent_meta,
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


def _torrent_bytes(info):
    return _bencode({"info": info, "announce": "http://tracker.test/announce"})


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


def test_bt_tracker_map(monkeypatch):
    monkeypatch.delenv("STREAMLIFT_BT_TRACKER", raising=False)
    assert _bt_tracker_map() == ""
    monkeypatch.setenv("STREAMLIFT_BT_TRACKER", "udp://tracker.test:1337/announce")
    assert _bt_tracker_map() == "udp://tracker.test:1337/announce"


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
    from streamlift_worker import downloader, torrent_metadata

    monkeypatch.setattr(downloader, "_ensure_aria2c", lambda: True)

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

    monkeypatch.setattr(torrent_metadata, "_metadata_phase", lambda *a, **kw: str(torrent_path))

    result = torrent_metadata.fetch_torrent_metadata(
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


def test_fetch_metadata_installs_aria2c_first(monkeypatch, tmp_path):
    """Ensure aria2c is installed before the metadata phase runs."""
    from streamlift_worker import downloader, torrent_metadata

    calls: list[str] = []
    monkeypatch.setattr(
        downloader,
        "_ensure_aria2c",
        lambda: (calls.append("ensure"), True)[1],
    )
    monkeypatch.setattr(
        torrent_metadata,
        "_metadata_phase",
        lambda *a, **kw: (calls.append("phase"), None)[1],
    )

    result = torrent_metadata.fetch_torrent_metadata(
        "magnet:?xt=urn:btih:aabbccdd112233445566778899aabbccdd"
    )
    assert result is None  # phase returned nothing
    assert calls == ["ensure", "phase"]


def test_fetch_metadata_skips_phase_when_aria2c_missing(monkeypatch):
    """Cannot install aria2c → RuntimeError and the metadata phase never runs."""
    import pytest

    from streamlift_worker import downloader, torrent_metadata

    monkeypatch.setattr(downloader, "_ensure_aria2c", lambda: False)
    calls: list[str] = []
    monkeypatch.setattr(
        torrent_metadata,
        "_metadata_phase",
        lambda *a, **kw: (calls.append("phase"), None)[1],
    )

    with pytest.raises(RuntimeError, match="aria2c"):
        torrent_metadata.fetch_torrent_metadata(
            "magnet:?xt=urn:btih:aabbccdd112233445566778899aabbccdd"
        )
    assert calls == []
