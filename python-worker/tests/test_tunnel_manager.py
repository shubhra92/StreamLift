"""Tests for the tunnel-only restart path (no Python process restart)."""

import os
import sys
import threading as _realthreading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from streamlift_worker import worker  # noqa: E402
from streamlift_worker.config import WorkerConfig  # noqa: E402


class _InlineThread(_realthreading.Thread):
    """Run the target synchronously so tests can assert immediately."""

    def start(self):
        self.run()  # noqa (deliberate inline execution)


class _FakeTunnel:
    def __init__(self, url: str, http_url: str | None = None, fail: bool = False):
        self.url = url
        self.http_url = http_url
        self.fail = fail
        self.stopped = False
        self.callback = None

    def start(self):
        if self.fail:
            raise RuntimeError("provider unavailable")
        return self.url

    def get_url(self):
        return self.url

    def get_http_url(self):
        return self.http_url

    def stop(self):
        self.stopped = True

    def on_url_change(self, callback):
        self.callback = callback


def _config(nonce: str = "old") -> WorkerConfig:
    return WorkerConfig(
        worker_id="w1",
        auth_token="tok",
        api_base_url="https://backend.test",
        compute_type="medium",
        download_location="local",
        tunnel_provider="serveo",
        tunnel_restart_nonce=nonce,
    )


def test_restart_swaps_only_the_tunnel(monkeypatch):
    old = _FakeTunnel("https://old.example")
    new = _FakeTunnel("https://new.example", "http://new.example")
    tunnels = iter([old, new])

    monkeypatch.setattr(worker, "_create_tunnel", lambda _config: next(tunnels))
    monkeypatch.setattr(
        worker.api,
        "fetch_worker_config",
        lambda *_args, **_kwargs: {"tunnelProvider": "pinggy", "pinggyToken": "token"},
    )
    calls = []

    def fake_register(_config, _ip, url):
        calls.append(("register", url))
        return "new-session-token"

    monkeypatch.setattr(worker.api, "register", fake_register)
    monkeypatch.setattr(
        worker, "update_public_http_url", lambda url: calls.append(("http", url))
    )
    monkeypatch.setattr(
        worker, "update_session_token", lambda token: calls.append(("token", token))
    )
    monkeypatch.setattr(worker.threading, "Thread", _InlineThread)

    manager = worker.TunnelManager(_config(), "203.0.113.1")
    assert manager.start() == "https://old.example"

    manager.maybe_restart("new")

    assert manager.current() is new
    assert old.stopped is True
    assert manager._restart_nonce == "new"
    assert ("http", "http://new.example") in calls
    assert ("register", "https://new.example") in calls
    assert ("token", "new-session-token") in calls


def test_failed_restart_keeps_the_existing_tunnel(monkeypatch):
    old = _FakeTunnel("https://old.example")
    bad = _FakeTunnel("https://bad.example", fail=True)
    tunnels = iter([old, bad])

    monkeypatch.setattr(worker, "_create_tunnel", lambda _config: next(tunnels))
    monkeypatch.setattr(
        worker.api,
        "fetch_worker_config",
        lambda *_args, **_kwargs: {"tunnelProvider": "pinggy", "pinggyToken": "token"},
    )
    monkeypatch.setattr(worker.api, "register", lambda *_args, **_kwargs: "session")
    monkeypatch.setattr(worker, "update_public_http_url", lambda _url: None)
    monkeypatch.setattr(worker, "update_session_token", lambda _token: None)
    monkeypatch.setattr(worker.threading, "Thread", _InlineThread)

    manager = worker.TunnelManager(_config(), "203.0.113.1")
    manager.start()
    manager.maybe_restart("bad")

    assert manager.current() is old
    assert old.stopped is False
    assert manager._restart_nonce == "old"
    assert manager._failed_nonce == "bad"
    assert manager._retry_after > 0
