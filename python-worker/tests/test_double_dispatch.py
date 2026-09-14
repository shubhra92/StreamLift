"""
Guards against a raced double-dispatch of the same download.

A race in the frontend dispatcher (trigger while the row is still `pending`,
then the scheduled 1s/5s/15s re-dispatch) used to start the SAME torrent twice
on the worker. One stream finished and posted `completed` while the other was
still uploading — the frontend showed a completed item with an alive upload.
This test locks in the three layers that close that hole:

  1. worker /download: same downloadId while busy → idempotent, no 2nd thread
  2. downloader: in-flight id dedupe — a duplicate start is a no-op
  3. streaming: throttled `uploading` status posts so the row never sits on
     `downloading` while the MEGA upload runs
"""
import asyncio
import os
import sys
import threading as _realthreading

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from streamlift_worker import downloader  # noqa: E402
from streamlift_worker import server as worker_server  # noqa: E402
from streamlift_worker.server import DownloadRequest  # noqa: E402


class _Cfg:
    worker_id = "w1"
    auth_token = "tok"
    download_location = "mega"
    api_base_url = "http://backend.test"
    server_port = 9999


def _make_downloader_api():
    api = {
        "updates": [],
        "status_update": lambda config, did, status, error=None, location_path=None, cloud_file_handle=None: (
            api["updates"].append((did, status, error))
        ),
    }
    return api


# ── 1. worker /download: same-id while busy → idempotent (no second thread) ──


def _reset_server_state():
    worker_server._current_task = {}
    worker_server._config = _Cfg()
    worker_server._session_token = "sess"


def test_trigger_download_same_id_while_busy_is_idempotent(monkeypatch):
    _reset_server_state()
    worker_server._current_task = {
        "downloadId": "d1", "status": "uploading", "progress": 9.4,
    }

    started = []

    class _SpyThread(_realthreading.Thread):
        def start(self):
            started.append(self)  # noqa
            super().start()

    monkeypatch.setattr(worker_server.threading, "Thread", _SpyThread)

    body = {"downloadId": "d1", "sourceUrl": "magnet:?xt=urn:btih:aa", "downloadType": "torrent"}
    res = _call_trigger(body)

    assert res["alreadyRunning"] is True
    assert started == []  # no second worker thread spawned


def test_trigger_download_different_id_while_busy_is_rejected():
    _reset_server_state()
    worker_server._current_task = {"downloadId": "busy", "status": "uploading"}

    body = {"downloadId": "other", "sourceUrl": "http://x/y", "downloadType": "http"}
    with pytest.raises(Exception) as exc:
        _call_trigger(body)
    assert getattr(exc.value, "status_code", None) == 409
    assert "busy with download busy" in str(exc.value.detail)


class _InlineThread(_realthreading.Thread):
    """Run the target synchronously so tests can assert on post-run state."""

    def start(self):
        self.run()  # noqa (deliberate inline execution for the test)


def test_current_task_slot_released_after_success(monkeypatch):
    _reset_server_state()

    from streamlift_worker import downloader

    runs = []

    def fake_process(config, task, current_task):
        runs.append(task["downloadId"])
        # Mimic a completed downloader run that leaves the slot populated —
        # the exact state the old code forgot to release.
        current_task.update({
            "downloadId": task["downloadId"],
            "status": "completed",
            "progress": 100,
            "startedAt": task["downloadId"] + ":start",
        })

    monkeypatch.setattr(downloader, "process_http_download", fake_process)
    monkeypatch.setattr(worker_server.threading, "Thread", _InlineThread)

    first = _call_trigger({"downloadId": "a", "sourceUrl": "http://x/a", "downloadType": "http"})
    assert first["success"] is True
    assert worker_server._current_task == {}  # slot released after completion

    # A different download is ACCEPTED (no 409 latch) and its downloader runs.
    second = _call_trigger({"downloadId": "b", "sourceUrl": "http://x/b", "downloadType": "http"})
    assert second["success"] is True
    assert runs == ["a", "b"]
    assert worker_server._current_task == {}


def test_current_task_slot_released_after_exception(monkeypatch):
    _reset_server_state()

    from streamlift_worker import downloader

    runs = []

    def failing_process(config, task, current_task):
        runs.append(task["downloadId"])
        raise RuntimeError("boom")

    monkeypatch.setattr(downloader, "process_http_download", failing_process)
    monkeypatch.setattr(worker_server.threading, "Thread", _InlineThread)

    first = _call_trigger({"downloadId": "a", "sourceUrl": "http://x/a", "downloadType": "http"})
    assert first["success"] is True
    assert worker_server._current_task == {}  # slot released even on failure

    _ = _call_trigger({"downloadId": "b", "sourceUrl": "http://x/b", "downloadType": "http"})
    assert runs == ["a", "b"]


def _call_trigger(body):
    # FastAPI endpoints are async functions; drive them with asyncio.
    req = DownloadRequest(**body)
    return asyncio.run(worker_server.trigger_download(req, "sess"))


# ── 2. downloader: in-flight dedupe (a duplicate start is a no-op) ────────────


def test_downloader_ignores_duplicate_inflight_torrent(monkeypatch):
    counted = {"runs": 0}
    started_holding = _realthreading.Event()
    release_holding = _realthreading.Event()

    monkeypatch.setattr(downloader, "api", _make_downloader_api())

    def inner(config, task, current_task):
        counted["runs"] += 1
        current_task["status"] = "downloading"
        # Hold the claim: mimic a long stream so a raced second dispatch
        # overlaps the first.
        started_holding.set()
        release_holding.wait(5)

    monkeypatch.setattr(downloader, "_process_torrent_download", inner)

    cfg = _Cfg()
    task = {"downloadId": "dup", "sourceUrl": "magnet:?xt=urn:btih:aa", "fileName": "x"}

    t1 = _realthreading.Thread(target=downloader.process_torrent_download, args=(cfg, task, {}))
    t1.start()
    assert started_holding.wait(2)
    downloader.process_torrent_download(cfg, task, {})  # overlapping duplicate → no-op
    release_holding.set()
    t1.join(2)

    assert counted["runs"] == 1
    assert downloader._active_download_ids == set()  # released after the run


def test_downloader_dedupe_releases_on_exception(monkeypatch):
    counted = {"runs": 0}

    monkeypatch.setattr(downloader, "api", _make_downloader_api())

    def inner(config, task, current_task):
        counted["runs"] += 1
        if counted["runs"] == 1:
            raise RuntimeError("boom")

    monkeypatch.setattr(downloader, "_process_http_download", inner)

    cfg = _Cfg()
    task = {"downloadId": "boom", "sourceUrl": "http://x/y", "fileName": "f"}

    with pytest.raises(RuntimeError):
        downloader.process_http_download(cfg, task, {})

    assert counted["runs"] == 1
    assert downloader._active_download_ids == set()  # released even on failure

    # And a follow-up start works again.
    downloader.process_http_download(cfg, task, {})
    assert counted["runs"] == 2


# ── 3. streaming: throttled 'uploading' progress posts ───────────────────────


def test_stream_posts_uploading_progress_throttled(monkeypatch):
    from streamlift_worker import aria2c_stream

    posted = []
    monkeypatch.setattr(
        aria2c_stream,
        "_post_upload_progress",
        lambda config, did, pct, total: posted.append((did, pct, total)),
    )

    clock = {"t": 1_000.0}
    monkeypatch.setattr(aria2c_stream.time, "time", lambda: clock["t"])

    cfg = _Cfg()
    task = {"status": "downloading", "progress": 0}
    progress_cb, _ = aria2c_stream._upload_progress_callback(cfg, "d1", task, 1000)

    # First tick at t=0: inside the 10s window → only live task state, no post.
    progress_cb(100, 1000)
    assert posted == []
    assert task["status"] == "uploading"
    assert task["progress"] == 10.0

    # +10s with the same bytes → the 10s gate fires → post.
    clock["t"] += 10
    progress_cb(200, 1000)
    assert posted == [("d1", 20.0, 1000)]

    # +5s (still inside 10s post gate) → no post despite a big byte jump.
    clock["t"] += 5
    progress_cb(900, 1000)
    assert len(posted) == 1

    # +5s more (10s post window) → posts again.
    clock["t"] += 5
    progress_cb(900, 1000)
    assert posted == [("d1", 20.0, 1000), ("d1", 90.0, 1000)]

    assert task["progress"] == 90.0


def test_stream_posts_initial_uploading_status(monkeypatch):
    from streamlift_worker import aria2c_stream

    posted = []
    monkeypatch.setattr(
        aria2c_stream,
        "_post_upload_progress",
        lambda config, did, pct, total: posted.append((did, pct, total)),
    )

    cfg = _Cfg()
    aria2c_stream._post_upload_progress(cfg, "d1", 0.0, 630_000_000)
    assert ("d1", 0.0, 630_000_000) in posted