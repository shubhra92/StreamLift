"""
Pinggy tunnel management — TCP mode (+tcp+force).

Uses raw TCP tunneling so Pinggy acts as a pure passthrough with zero HTTP
proxy buffering. Essential for SSE streaming.

Captures PTY output via `script` command (Pinggy writes the URL to the
terminal, not to stdout/stderr pipes). Platform-aware syntax:
  - Linux/Colab : script -q -c 'cmd' logfile
  - macOS       : script -q logfile cmd [args...]

The macOS branch is for local development only — Colab is always Linux.
"""

import os
import re
import shlex
import subprocess
import sys
import threading
import time
from typing import Optional

from streamlift_worker import logger

_LOG_FILE      = "/tmp/pinggy_streamlift.txt"
_TCP_URL_RE    = re.compile(r"tcp://(\S+):(\d+)")
_POLL_INTERVAL = 0.5   # seconds between log file polls
_URL_TIMEOUT   = 45    # seconds to wait for URL
_RESTART_DELAY = 5     # seconds before restart on unexpected exit


class PinggyTunnel:
    """
    Opens a Pinggy TCP tunnel (+tcp+force) via SSH.
    Captures the public URL from PTY output using `script`.
    Auto-restarts if the tunnel drops.
    """

    def __init__(self, token: str, port: int = 8000):
        self._token = token
        self._port  = port
        self._url:  Optional[str]              = None
        self._proc: Optional[subprocess.Popen] = None
        self._lock  = threading.Lock()
        self._on_url_change = None

    # ── Public API ────────────────────────────────────────────────────────────

    def start(self) -> str:
        """Start the tunnel and block until the public TCP URL is ready."""
        url = self._launch()
        threading.Thread(target=self._watchdog, daemon=True).start()
        return url

    def get_url(self) -> Optional[str]:
        with self._lock:
            return self._url

    def stop(self) -> None:
        with self._lock:
            if self._proc and self._proc.poll() is None:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._proc.kill()
            self._proc = None
            self._url  = None
        subprocess.run(["pkill", "-f", "a.pinggy.io"], capture_output=True)

    def on_url_change(self, callback) -> None:
        self._on_url_change = callback

    # ── Internal ──────────────────────────────────────────────────────────────

    def _launch(self) -> str:
        """Start SSH subprocess and wait for the tcp:// URL to appear."""
        try:
            os.remove(_LOG_FILE)
        except FileNotFoundError:
            pass

        # +tcp+force = raw TCP passthrough, no HTTP proxy, no buffering
        ssh_args = [
            "ssh", "-p", "443",
            "-R", f"0:localhost:{self._port}",
            "-o", "StrictHostKeyChecking=no",
            "-o", "ServerAliveInterval=30",
            "-o", "ExitOnForwardFailure=yes",
            f"{self._token}+tcp+force@a.pinggy.io",
        ]

        logger.log("info", f"Starting Pinggy TCP tunnel on port {self._port}...")

        # `script` gives SSH a PTY so Pinggy prints the URL.
        # Syntax differs between platforms — only matters for local dev on macOS.
        # Colab (production) is always Linux.
        if sys.platform == "darwin":
            # macOS: script -q logfile cmd [args...]
            cmd = ["script", "-q", _LOG_FILE] + ssh_args
        else:
            # Linux / Colab: script -q -c 'cmd string' logfile
            cmd = ["script", "-q", "-c", shlex.join(ssh_args), _LOG_FILE]

        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        with self._lock:
            self._proc = proc

        url = self._wait_for_url(proc)

        if not url:
            proc.terminate()
            try:
                with open(_LOG_FILE, "r", errors="ignore") as f:
                    content = f.read()
                logger.log("error", f"Pinggy output:\n{content[-500:]}")
            except Exception:
                pass
            raise RuntimeError(
                f"Pinggy tunnel did not provide a URL within {_URL_TIMEOUT}s. "
                "Check your Pinggy token."
            )

        with self._lock:
            self._url = url

        logger.log("info", f"Pinggy tunnel ready: {url}")

        if self._on_url_change:
            try:
                self._on_url_change(url)
            except Exception as e:
                logger.log("warning", f"URL change callback error: {e}")

        return url

    def _wait_for_url(self, proc: subprocess.Popen) -> Optional[str]:
        """Poll the log file until a tcp:// URL appears or timeout."""
        deadline = time.time() + _URL_TIMEOUT

        while time.time() < deadline:
            time.sleep(_POLL_INTERVAL)

            if proc.poll() is not None:
                logger.log("error", "Pinggy SSH process exited early")
                return None

            if not os.path.exists(_LOG_FILE):
                continue

            try:
                with open(_LOG_FILE, "rb") as f:
                    raw = f.read()
            except Exception:
                continue

            content = _strip_ansi(raw.decode("utf-8", errors="ignore"))

            match = _TCP_URL_RE.search(content)
            if match:
                return f"tcp://{match.group(1)}:{match.group(2)}"

        return None

    def _watchdog(self) -> None:
        """Restart the tunnel if it exits unexpectedly."""
        while True:
            with self._lock:
                proc = self._proc

            if proc is None:
                return

            proc.wait()

            with self._lock:
                if self._proc is None:
                    return
                logger.log("warning",
                    f"Pinggy tunnel exited, restarting in {_RESTART_DELAY}s...")
                self._url = None

            time.sleep(_RESTART_DELAY)

            try:
                new_url = self._launch()
                logger.log("info", f"Pinggy tunnel restarted: {new_url}")
            except Exception as e:
                logger.log("error", f"Failed to restart Pinggy tunnel: {e}")
                time.sleep(_RESTART_DELAY * 2)


def _strip_ansi(text: str) -> str:
    """Remove ANSI escape codes and control characters."""
    text = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', ' ', text)
    text = re.sub(r'\x1b[()][AB012]', '', text)
    text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', ' ', text)
    return text
