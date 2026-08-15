"""
Pinggy tunnel management — HTTPS HTTP mode.

Uses Pinggy's HTTP tunnel with TLS terminated by Pinggy. The resulting public
HTTPS URL is safe to call from a browser hosted on HTTPS (for example, Vercel).
The worker itself still serves plain HTTP locally on port 8000.

Forces an SSH pseudo-terminal and captures its combined output directly. This
works in Colab and lets the worker report the real Pinggy error when startup
fails, rather than hiding it behind a terminal wrapper.
"""

import json
import re
import subprocess
import threading
import time
from typing import Optional
from urllib.parse import urlparse
from urllib.request import urlopen

from streamlift_worker import logger

# Pinggy's terminal output also contains control-plane links such as
# dashboard.pinggy.io. Those are not tunnel URLs and must never be registered
# as a worker endpoint.
_HTTPS_URL_RE   = re.compile(r"https://[A-Za-z0-9.-]+(?::\d+)?")
_PINGGY_CONTROL_HOSTS = {
    "a.pinggy.io",
    "dashboard.pinggy.io",
    "free.pinggy.io",
    "pro.pinggy.io",
}
_POLL_INTERVAL = 0.5   # seconds between captured-output polls
_URL_TIMEOUT   = 45    # seconds to wait for URL
_RESTART_DELAY = 5     # seconds before restart on unexpected exit
_MAX_CAPTURED_OUTPUT = 12_000
# Pinggy exposes tunnel metadata on its remote debugger port 4300. Bind it to
# an uncommon local port so the worker can retrieve URLs even when Pinggy's
# terminal banner is absent (as observed in Google Colab).
_LOCAL_DEBUGGER_PORT = 4301
_REMOTE_DEBUGGER_PORT = 4300


class PinggyTunnel:
    """
    Opens a Pinggy HTTP tunnel with a public HTTPS URL via SSH.
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
        self._output = ""

    # ── Public API ────────────────────────────────────────────────────────────

    def start(self) -> str:
        """Start the tunnel and block until the public HTTPS URL is ready."""
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

    def on_url_change(self, callback) -> None:
        self._on_url_change = callback

    # ── Internal ──────────────────────────────────────────────────────────────

    def _launch(self) -> str:
        """Start SSH subprocess and wait for the HTTPS URL to appear."""
        # HTTP is Pinggy's default tunnel type. x:https prevents accidental
        # HTTP use from an HTTPS dashboard; x:passpreflight lets browser CORS
        # preflight requests reach FastAPI unchanged.
        ssh_args = [
            "ssh", "-tt", "-p", "443",
            "-R", f"0:localhost:{self._port}",
            "-L", f"{_LOCAL_DEBUGGER_PORT}:localhost:{_REMOTE_DEBUGGER_PORT}",
            "-o", "StrictHostKeyChecking=no",
            "-o", "ServerAliveInterval=30",
            "-o", "ExitOnForwardFailure=yes",
            f"{self._token}+force@free.pinggy.io",
            "x:https",
            "x:passpreflight",
        ]

        logger.log("info", f"Starting Pinggy HTTPS tunnel on port {self._port}...")

        proc = subprocess.Popen(
            ssh_args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        with self._lock:
            self._proc = proc
            self._output = ""

        threading.Thread(target=self._capture_output, args=(proc,), daemon=True).start()

        url = self._wait_for_url(proc)

        if not url:
            proc.terminate()
            output = self._get_output().strip()
            if output:
                logger.log("error", f"Pinggy SSH output:\n{self._redact(output[-2_000:])}")
            else:
                logger.log("error", "Pinggy SSH produced no output")
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
        """Poll captured SSH output until Pinggy prints an HTTPS URL or timeout."""
        deadline = time.time() + _URL_TIMEOUT

        while time.time() < deadline:
            time.sleep(_POLL_INTERVAL)

            if proc.poll() is not None:
                logger.log("error", "Pinggy SSH process exited early")
                return None

            content = _strip_ansi(self._get_output())

            url = _find_public_https_url(content)
            if url:
                return url

            # The debugger API is more reliable than scraping SSH terminal
            # output and returns both the HTTP and HTTPS tunnel URLs.
            url = self._get_debugger_url()
            if url:
                return url

        return None

    def _capture_output(self, proc: subprocess.Popen) -> None:
        """Read SSH output continuously so it cannot block on a full pipe."""
        if proc.stdout is None:
            return
        try:
            for line in iter(proc.stdout.readline, ""):
                with self._lock:
                    self._output = (self._output + line)[-_MAX_CAPTURED_OUTPUT:]
        finally:
            proc.stdout.close()

    def _get_output(self) -> str:
        with self._lock:
            return self._output

    def _get_debugger_url(self) -> Optional[str]:
        try:
            with urlopen(
                f"http://127.0.0.1:{_LOCAL_DEBUGGER_PORT}/urls",
                timeout=1,
            ) as response:
                payload = json.loads(response.read().decode("utf-8"))
            urls = payload.get("urls", []) if isinstance(payload, dict) else []
            return _find_public_https_url("\n".join(urls))
        except Exception:
            # The SSH local forward/debugger will not be ready immediately.
            return None

    def _redact(self, text: str) -> str:
        return text.replace(self._token, "[REDACTED]")

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


def _find_public_https_url(output: str) -> Optional[str]:
    """Return a public Pinggy HTTPS tunnel URL from terminal output.

    Free tunnels currently use ``*.run.pinggy-free.link`` or
    ``*.free.pinggy.net``. The broader ``*.pinggy.io`` check also supports
    public HTTPS URLs issued by paid or legacy Pinggy configurations, while
    excluding known service endpoints.
    """
    for candidate in _HTTPS_URL_RE.findall(output):
        host = urlparse(candidate).hostname
        if not host or host in _PINGGY_CONTROL_HOSTS:
            continue
        if (
            host.endswith(".pinggy-free.link")
            or host.endswith(".free.pinggy.net")
            or host.endswith(".pinggy.io")
        ):
            return candidate
    return None
