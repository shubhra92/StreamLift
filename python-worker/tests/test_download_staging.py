"""HTTP and torrent downloads stage the payload on disk before uploading.

These tests lock in the post-streaming behaviour: the worker never uploads
bytes while it is still downloading. For Mega targets it must first write the
complete payload to its staging directory, then hand that file to Mega.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from streamlift_worker import downloader  # noqa: E402


class _Cfg:
    download_location = "mega"
    chunk_size = 4

    def __init__(self, location="mega"):
        self.download_location = location


class _FakeApi:
    def __init__(self):
        self.updates = []

    def status_update(
        self,
        config,
        download_id,
        status,
        error="",
        location_path=None,
        cloud_file_handle=None,
    ):
        self.updates.append((status, error, cloud_file_handle, location_path))

    def statuses(self):
        return [update[0] for update in self.updates]


class _FakeResponse:
    def __init__(self, chunks, content_length):
        self._chunks = chunks
        self.headers = {"content-length": str(content_length)}

    def raise_for_status(self):
        return None

    def iter_content(self, chunk_size=1):
        yield from self._chunks

    def close(self):
        return None


# ── HTTP ─────────────────────────────────────────────────────────────────────


def test_http_mega_downloads_to_disk_then_uploads(monkeypatch, tmp_path):
    monkeypatch.setattr(downloader, "_downloads_dir", lambda: str(tmp_path))
    monkeypatch.setattr(
        downloader.requests,
        "get",
        lambda *a, **kw: _FakeResponse([b"hello ", b"world"], 11),
    )

    api = _FakeApi()
    monkeypatch.setattr(downloader, "api", api)

    uploaded = {}

    def fake_upload(config, file_path, file_name, **kwargs):
        # The upload must only start once the full payload is on disk.
        assert os.path.isfile(file_path)
        with open(file_path, "rb") as handle:
            assert handle.read() == b"hello world"
        uploaded["path"] = file_path
        uploaded["name"] = file_name
        return "NODE123"

    monkeypatch.setattr(downloader.mega, "upload_file_to_mega", fake_upload)

    task = {
        "downloadId": "http1",
        "sourceUrl": "https://example.test/file.bin",
        "fileName": "file.bin",
    }
    current = {}

    downloader.process_http_download(_Cfg(), task, current)

    assert uploaded["name"] == "file.bin"
    assert api.statuses() == ["downloading", "uploading", "completed"]
    assert api.updates[-1][2] == "NODE123"  # cloud_file_handle
    assert not os.path.exists(os.path.dirname(uploaded["path"]))  # staging removed
    assert current == {}


def test_http_mega_upload_failure_reports_failed(monkeypatch, tmp_path):
    monkeypatch.setattr(downloader, "_downloads_dir", lambda: str(tmp_path))
    monkeypatch.setattr(
        downloader.requests,
        "get",
        lambda *a, **kw: _FakeResponse([b"data"], 4),
    )
    api = _FakeApi()
    monkeypatch.setattr(downloader, "api", api)
    monkeypatch.setattr(downloader.mega, "upload_file_to_mega", lambda *a, **kw: "")

    task = {
        "downloadId": "http2",
        "sourceUrl": "https://example.test/file.bin",
        "fileName": "file.bin",
    }
    current = {}

    downloader.process_http_download(_Cfg(), task, current)

    assert api.statuses() == ["downloading", "uploading", "failed"]
    assert current == {}


def test_http_cancel_never_uploads(monkeypatch, tmp_path):
    monkeypatch.setattr(downloader, "_downloads_dir", lambda: str(tmp_path))
    monkeypatch.setattr(
        downloader.requests,
        "get",
        lambda *a, **kw: _FakeResponse([b"hello ", b"world"], 11),
    )
    api = _FakeApi()
    monkeypatch.setattr(downloader, "api", api)

    calls = {"cancel": 0}

    def cancelled(download_id):
        calls["cancel"] += 1
        return True

    monkeypatch.setattr(downloader, "_is_cancelled", cancelled)
    upload_called = {"count": 0}
    monkeypatch.setattr(
        downloader.mega,
        "upload_file_to_mega",
        lambda *a, **kw: upload_called.__setitem__("count", upload_called["count"] + 1),
    )

    task = {
        "downloadId": "http3",
        "sourceUrl": "https://example.test/file.bin",
        "fileName": "file.bin",
    }
    current = {}

    downloader.process_http_download(_Cfg(), task, current)

    assert upload_called["count"] == 0
    assert api.statuses() == ["downloading", "failed"]
    assert api.updates[-1][1] == "Cancelled by user"


# ── torrent ──────────────────────────────────────────────────────────────────


class _FakeProcess:
    def __init__(self, lines, returncode=0):
        self.stdout = iter(lines)
        self.returncode = returncode
        self.terminated = False

    def wait(self):
        return self.returncode

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.terminated = True


def _install_fake_aria2c(monkeypatch, payload_name="torrent.bin", cancelled=False):
    """Make aria2c 'download' one file into the staging directory."""
    state = {}

    def fake_build(save_path, magnet_link, file_indices):
        payload = os.path.join(save_path, payload_name)
        with open(payload, "wb") as handle:
            handle.write(b"payload-bytes")
        state["payload"] = payload
        state["save_path"] = save_path
        return ["aria2c"]

    monkeypatch.setattr(downloader, "_build_aria2c_cmd", fake_build)
    monkeypatch.setattr(downloader, "_ensure_aria2c", lambda: True)

    lines = ["[#abc 0B/0B(0%) CN:0]"]

    def fake_popen(cmd, **kwargs):
        if not cancelled:
            lines.append(f"Download complete: {state['payload']}")
        return _FakeProcess(lines)

    monkeypatch.setattr(downloader.subprocess, "Popen", fake_popen)
    return state


def test_torrent_mega_downloads_to_disk_then_uploads(monkeypatch, tmp_path):
    monkeypatch.setattr(downloader, "_downloads_dir", lambda: str(tmp_path))
    state = _install_fake_aria2c(monkeypatch)

    api = _FakeApi()
    monkeypatch.setattr(downloader, "api", api)

    uploaded = {}

    def fake_upload(config, file_path, file_name, **kwargs):
        assert os.path.isfile(file_path)
        with open(file_path, "rb") as handle:
            assert handle.read() == b"payload-bytes"
        uploaded["path"] = file_path
        return "TORRENTNODE"

    monkeypatch.setattr(downloader.mega, "upload_file_to_mega", fake_upload)

    task = {
        "downloadId": "torrent1",
        "sourceUrl": "magnet:?xt=urn:btih:aabbccdd112233445566778899aabbccdd",
        "fileName": "torrent.bin",
    }
    current = {}

    downloader.process_torrent_download(_Cfg(), task, current)

    assert uploaded["path"].startswith(state["save_path"])
    assert api.statuses() == ["downloading", "uploading", "completed"]
    assert api.updates[-1][2] == "TORRENTNODE"
    assert not os.path.exists(state["save_path"])  # staging removed
    assert current == {}


def test_torrent_download_cancel_skips_upload(monkeypatch, tmp_path):
    monkeypatch.setattr(downloader, "_downloads_dir", lambda: str(tmp_path))
    state = _install_fake_aria2c(monkeypatch, cancelled=True)

    api = _FakeApi()
    monkeypatch.setattr(downloader, "api", api)
    monkeypatch.setattr(downloader, "_is_cancelled", lambda download_id: True)

    uploaded = {"count": 0}
    monkeypatch.setattr(
        downloader.mega,
        "upload_file_to_mega",
        lambda *a, **kw: uploaded.__setitem__("count", uploaded["count"] + 1),
    )

    task = {
        "downloadId": "torrent2",
        "sourceUrl": "magnet:?xt=urn:btih:aabbccdd112233445566778899aabbccdd",
        "fileName": "torrent.bin",
    }
    current = {}

    downloader.process_torrent_download(_Cfg(), task, current)

    assert uploaded["count"] == 0
    assert api.statuses() == ["downloading", "failed"]
    assert api.updates[-1][1] == "Cancelled by user"
    assert not os.path.exists(state["save_path"])


# ── torrent selection vs. piece-sharing neighbours ──────────────────────────


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


def _install_fake_multi_file_aria2c(monkeypatch, files, torrent_files):
    """Simulate aria2c leaving several files (and .torrent metadata) on disk."""
    state = {}

    def fake_build(save_path, magnet_link, file_indices):
        for relative, content in files.items():
            path = os.path.join(save_path, relative)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as handle:
                handle.write(content)

        torrent_bytes = _bencode({
            "announce": "http://tracker.test/announce",
            "info": {
                "name": "bundle",
                "piece length": 16_384,
                "pieces": b"\x00" * 20,
                "files": torrent_files,
            },
        })
        torrent_path = os.path.join(
            save_path, "aabbccdd" * 5 + ".torrent"
        )
        with open(torrent_path, "wb") as handle:
            handle.write(torrent_bytes)

        state["save_path"] = save_path
        state["torrent_path"] = torrent_path
        return ["aria2c"]

    monkeypatch.setattr(downloader, "_build_aria2c_cmd", fake_build)
    monkeypatch.setattr(downloader, "_ensure_aria2c", lambda: True)

    def fake_popen(cmd, **kwargs):
        return _FakeProcess([
            "[#abc 0B/0B(0%) CN:0]",
            f"Download complete: {state['save_path']}",
        ])

    monkeypatch.setattr(downloader.subprocess, "Popen", fake_popen)
    return state


def _torrent_fixture_files():
    return {
        "bundle/movie.mp4": b"video-bytes",
        "bundle/movie.srt": b"subtitle-bytes",
    }


def _torrent_fixture_meta():
    return [
        {"length": len(b"video-bytes"), "path": ["movie.mp4"]},
        {"length": len(b"subtitle-bytes"), "path": ["movie.srt"]},
    ]


def test_torrent_single_selection_ignores_piece_neighbour(monkeypatch, tmp_path):
    """A neighbour written because it shares a piece must not be uploaded."""
    monkeypatch.setattr(downloader, "_downloads_dir", lambda: str(tmp_path))
    state = _install_fake_multi_file_aria2c(
        monkeypatch, _torrent_fixture_files(), _torrent_fixture_meta()
    )

    api = _FakeApi()
    monkeypatch.setattr(downloader, "api", api)

    uploaded = {}

    def fake_upload(config, file_path, file_name, **kwargs):
        uploaded["path"] = file_path
        uploaded["name"] = file_name
        return "NODE"

    folder_calls = []
    monkeypatch.setattr(downloader.mega, "upload_file_to_mega", fake_upload)
    monkeypatch.setattr(
        downloader.mega,
        "upload_files_to_mega_folder",
        lambda *a, **kw: folder_calls.append((a, kw)) or True,
    )

    task = {
        "downloadId": "torrent-select-1",
        "sourceUrl": "magnet:?xt=urn:btih:aabbccdd112233445566778899aabbccdd",
        "fileName": "movie.mp4",
        "fileIndices": "[0]",
    }

    downloader.process_torrent_download(_Cfg(), task, {})

    assert uploaded["name"] == "movie.mp4"
    assert uploaded["path"].endswith("bundle/movie.mp4")
    assert "movie.srt" not in uploaded["path"]
    assert folder_calls == []
    assert api.statuses() == ["downloading", "uploading", "completed"]
    assert not os.path.exists(state["save_path"])


def test_torrent_multi_selection_uploads_matching_files_into_folder(monkeypatch, tmp_path):
    monkeypatch.setattr(downloader, "_downloads_dir", lambda: str(tmp_path))
    _install_fake_multi_file_aria2c(
        monkeypatch, _torrent_fixture_files(), _torrent_fixture_meta()
    )

    api = _FakeApi()
    monkeypatch.setattr(downloader, "api", api)

    single_calls = []
    folder_calls = []
    monkeypatch.setattr(
        downloader.mega,
        "upload_file_to_mega",
        lambda *a, **kw: single_calls.append((a, kw)) or "NODE",
    )

    def fake_folder(config, files, folder_name, **kwargs):
        folder_calls.append((files, folder_name))
        return True

    monkeypatch.setattr(downloader.mega, "upload_files_to_mega_folder", fake_folder)

    task = {
        "downloadId": "torrent-select-2",
        "sourceUrl": "magnet:?xt=urn:btih:aabbccdd112233445566778899aabbccdd",
        "fileName": "bundle",
        "fileIndices": "[0, 1]",
    }

    downloader.process_torrent_download(_Cfg(), task, {})

    assert single_calls == []
    assert len(folder_calls) == 1
    files, folder_name = folder_calls[0]
    assert folder_name == "bundle"
    assert sorted(os.path.basename(f) for f in files) == ["movie.mp4", "movie.srt"]
    assert api.statuses() == ["downloading", "uploading", "completed"]


def test_torrent_numeric_string_indices_are_coerced(monkeypatch, tmp_path):
    monkeypatch.setattr(downloader, "_downloads_dir", lambda: str(tmp_path))
    _install_fake_multi_file_aria2c(
        monkeypatch, _torrent_fixture_files(), _torrent_fixture_meta()
    )

    api = _FakeApi()
    monkeypatch.setattr(downloader, "api", api)

    uploaded = {}
    monkeypatch.setattr(
        downloader.mega,
        "upload_file_to_mega",
        lambda config, path, name, **kw: uploaded.update(path=path, name=name) or "NODE",
    )
    folder_calls = []
    monkeypatch.setattr(
        downloader.mega,
        "upload_files_to_mega_folder",
        lambda *a, **kw: folder_calls.append((a, kw)) or True,
    )

    task = {
        "downloadId": "torrent-select-3",
        "sourceUrl": "magnet:?xt=urn:btih:aabbccdd112233445566778899aabbccdd",
        "fileName": "movie.srt",
        "fileIndices": '["1"]',
    }

    downloader.process_torrent_download(_Cfg(), task, {})

    assert uploaded["name"] == "movie.srt"
    assert uploaded["path"].endswith("bundle/movie.srt")
    assert folder_calls == []


def test_torrent_without_selection_keeps_upload_everything_behaviour(monkeypatch, tmp_path):
    monkeypatch.setattr(downloader, "_downloads_dir", lambda: str(tmp_path))
    _install_fake_multi_file_aria2c(
        monkeypatch, _torrent_fixture_files(), _torrent_fixture_meta()
    )

    api = _FakeApi()
    monkeypatch.setattr(downloader, "api", api)

    folder_calls = []
    monkeypatch.setattr(
        downloader.mega,
        "upload_file_to_mega",
        lambda *a, **kw: "NODE",
    )

    def fake_folder(config, files, folder_name, **kwargs):
        folder_calls.append((files, folder_name))
        return True

    monkeypatch.setattr(downloader.mega, "upload_files_to_mega_folder", fake_folder)

    task = {
        "downloadId": "torrent-select-all",
        "sourceUrl": "magnet:?xt=urn:btih:aabbccdd112233445566778899aabbccdd",
        "fileName": "movie.mp4",
    }

    downloader.process_torrent_download(_Cfg(), task, {})

    assert len(folder_calls) == 1
    assert sorted(os.path.basename(f) for f in folder_calls[0][0]) == [
        "movie.mp4",
        "movie.srt",
    ]
