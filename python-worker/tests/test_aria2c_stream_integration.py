"""End-to-end: aria2c torrent streaming into (mocked) MEGA — no libtorrent.

Peer discovery happens via a tiny in-process tracker (the same seam a
self-hosted deployment uses with STREAMLIFT_BT_TRACKER). Two real aria2c
processes play the roles:
  * seeder — given the .torrent + the files (already in place), it seeds.
  * leecher — the worker's engine: magnet → metadata phase (saves .torrent),
    then the streaming phase the pump reads.
mega.stream_to_mega is mocked to capture the stream bytes.

Everything is deliberate: Colab ships aria2c (never libtorrent), so this test
exercises exactly the code path Colab will hit.
"""

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

if not shutil.which("aria2c"):
    pytest.skip("aria2c not installed", allow_module_level=True)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from streamlift_worker import aria2c_stream  # noqa: E402
from streamlift_worker import local_files  # noqa: E402
from streamlift_worker import mega as mega_mod  # noqa: E402


# ── tiny bencode encoder (tracker response + torrent construction) ───────────


def _bencode(obj):
    # Canonical-like bencode: dict keys are sorted so the produced info dict
    # byte-for-byte matches what aria2c re-bencodes when hashing a torrent
    # (unsorted keys → a different infohash → peers land in separate swarms).
    if isinstance(obj, int):
        return b"i%de" % obj
    if isinstance(obj, str):
        obj = obj.encode("utf-8")
    if isinstance(obj, bytes):
        return b"%d:%s" % (len(obj), obj)
    if isinstance(obj, list):
        return b"l" + b"".join(_bencode(x) for x in obj) + b"e"
    items = sorted(obj.items())
    return b"d" + b"".join(_bencode(k) + _bencode(v) for k, v in items) + b"e"


def _make_torrent(files, tracker_url, piece_size=16 * 1024):
    """files: list of (name, size, bytes). Returns (torrent_bytes, info_hash)."""
    payload = b"".join(blob for _n, _s, blob in files)
    pieces = b"".join(
        hashlib.sha1(payload[i : i + piece_size]).digest()
        for i in range(0, len(payload), piece_size)
    )
    info = {
        "name": "twofiles",
        "piece length": piece_size,
        "pieces": pieces,
        "files": [
            {"length": size, "path": [name]} for name, size, _blob in files
        ],
    }
    root = {"announce": tracker_url, "info": info}
    info_hash = hashlib.sha1(_bencode(info)).hexdigest()
    return _bencode(root), info_hash


# ── in-process tracker ───────────────────────────────────────────────────────


SWARM: dict[bytes, set] = {}
LOCK = threading.Lock()


class _Tracker(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/announce":
            self.send_error(404)
            return
        params = urllib.parse.parse_qs(parsed.query, encoding="latin-1")
        info_hash = bytes(params.get("info_hash", [""])[0], "latin1")
        port = int(params.get("port", ["0"])[0])
        event = params.get("event", [""])[0]
        host = self.client_address[0]
        with LOCK:
            if event == "stopped":
                SWARM.get(info_hash, set()).discard((host, port))
            else:
                SWARM.setdefault(info_hash, set()).add((host, port))
            others = [(h, p) for (h, p) in SWARM.get(info_hash, set())
                      if (h, p) != (host, port)]
        resp = _bencode({
            "interval": 3,
            "complete": 1,
            "incomplete": 1,
            "peers": [{"ip": h.encode(), "port": p} for (h, p) in others],
        })
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)
        self.wfile.flush()


class _Cfg:
    api_base_url = None
    api_token = None
    worker_id = None
    device_type = None
    mega_email = ""
    mega_password = ""


def test_stream_torrent_to_mega_real_aria2c(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="sl_aria2_")
    seed_dir = os.path.join(tmp, "seed")
    os.makedirs(seed_dir)

    files = [("a.bin", 65_536), ("b.bin", 32_768)]
    content = {}
    serve_dir = os.path.join(seed_dir, "twofiles")
    os.makedirs(serve_dir, exist_ok=True)
    for name, size in files:
        blob = bytes((i * 3 + len(name) * 11) % 256 for i in range(size))
        content[name] = blob
        with open(os.path.join(serve_dir, name), "wb") as f:
            f.write(blob)

    tracker_server = ThreadingHTTPServer(("127.0.0.1", 0), _Tracker)
    tracker_url = f"http://127.0.0.1:{tracker_server.server_address[1]}/announce"
    tracker_thread = threading.Thread(target=tracker_server.serve_forever, daemon=True)
    tracker_thread.start()

    torrent_bytes, info_hash = _make_torrent(
        [(name, size, content[name]) for name, size in files], tracker_url
    )
    torrent_path = os.path.join(tmp, "seed.torrent")
    with open(torrent_path, "wb") as f:
        f.write(torrent_bytes)

    # Seeder = a second aria2c (files already in place → it verifies + seeds).
    seeder = subprocess.Popen(
        [
            "aria2c",
            "--dir", seed_dir,
            "--check-integrity=true",
            "--seed-time=1000",
            "--seed-ratio=0",
            "--enable-dht=false",
            "--enable-peer-exchange=false",
            "--console-log-level=error",
            torrent_path,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(2.0)  # let the seeder verify + announce to the tracker

        magnet = f"magnet:?xt=urn:btih:{info_hash}&dn=twofiles"
        received = []

        class _Client:
            def create_folder(self, name):
                return type("F", (), {"node_id": "NODE"})()

        def fake_stream_to_mega(config, stream, file_size, file_name, **kw):
            blob = b""
            while len(blob) < file_size:
                chunk = stream.read(file_size - len(blob))
                if not chunk:
                    break
                blob += chunk
            received.append((file_name, blob))
            return len(blob) == file_size

        monkeypatch.setattr(mega_mod, "stream_to_mega", fake_stream_to_mega)
        monkeypatch.setattr(mega_mod, "get_mega_client", lambda config: _Client())
        monkeypatch.setattr(local_files, "downloads_dir", lambda: tmp)

        task = {"status": "downloading", "progress": 0}
        disk_seen = []
        done_flag = threading.Event()

        def monitor():
            while not done_flag.is_set():
                for root, _dirs, fns in os.walk(tmp):
                    for fn in fns:
                        if ".stream-" in root and not fn.endswith(".aria2"):
                            try:
                                disk_seen.append(os.path.getsize(os.path.join(root, fn)))
                            except OSError:
                                pass
                time.sleep(0.02)

        mon = threading.Thread(target=monitor, daemon=True)
        mon.start()
        try:
            ok = aria2c_stream.stream_torrent_to_mega(
                _Cfg(), "dl-1", magnet, None, "twofiles", task,
                tracker=tracker_url,
            )
        finally:
            done_flag.set()

        assert ok is True, f"stream_torrent_to_mega returned False (task={task})"
        assert [n for n, _ in received] == ["a.bin", "b.bin"]
        assert received[0][1] == content["a.bin"]
        assert received[1][1] == content["b.bin"]

        sizes = [s for s in disk_seen if s > 0]
        assert sizes, "no scratch files observed"
        assert min(sizes) < 65_536, f"disk never bounded: min {min(sizes)}"

        leftovers = [p for p in os.listdir(tmp) if ".stream-" in p]
        assert not leftovers, leftovers
    finally:
        seeder.terminate()
        try:
            seeder.wait(timeout=5)
        except subprocess.TimeoutExpired:
            seeder.kill()
        tracker_server.shutdown()