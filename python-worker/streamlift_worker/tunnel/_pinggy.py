"""
PinggyTunnel — HTTP + HTTPS reverse tunnel via Pinggy's SSH gateway.

Opens a Pinggy HTTP tunnel with TLS terminated by Pinggy. The resulting public
HTTPS URL is safe to call from a browser on HTTPS (e.g. Vercel) and its
matching plain-HTTP URL is kept for native browser-download redirects (direct
``<a download>`` links bypass HTTPS and need a plain-HTTP address).

Uses SSH port 443 so the tunnel works on networks that block port 22 (Colab).
Forces a pseudo-terminal and captures combined output directly so the worker
can surface the real Pinggy error when startup fails.
"""

import json
import re
import socket
import subprocess
import threading
import time
from typing import Optional
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from streamlift_worker import logger
from streamlift_worker.tunnel._base import BaseTunnel, _RESTART_DELAY

# ── Pinggy-specific constants ─────────────────────────────────────────────────

_TUNNEL_URL_RE  = re.compile(r"https?://[A-Za-z0-9.-]+(?::\d+)?")

# Control-plane hostnames that appear in Pinggy output but are NOT tunnel URLs.
_PINGGY_CONTROL_HOSTS = {
    "a.pinggy.io",
    "dashboard.pinggy.io",
    "free.pinggy.io",
    "pro.pinggy.io",
}

_POLL_INTERVAL              = 0.5   # seconds between output polls
_URL_TIMEOUT                = 45    # seconds to wait for the tunnel URL
_HTTP_URL_DISCOVERY_TIMEOUT = 8     # seconds to confirm the matching HTTP URL
# Pinggy exposes tunnel metadata on remote debugger port 4300. We bind it to a
# free local port so URL discovery still works when the SSH banner is absent
# (Colab). The port must be per-instance: a hot-swap starts the new tunnel while
# the old one is still running, and both cannot bind the same local port.
_REMOTE_DEBUGGER_PORT = 4300


def _pick_local_debugger_port() -> int:
    """Return an unused localhost port for the Pinggy debugger forward."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _strip_ansi_pinggy(text: str) -> str:
    """Remove ANSI escape codes and non-printable control characters."""
    text = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', ' ', text)
    text = re.sub(r'\x1b[()][AB012]', '', text)
    text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', ' ', text)
    return text


def _find_public_tunnel_urls(output: str) -> Optional[tuple[str, str]]:
    """Return matching public Pinggy HTTPS + HTTP URLs from terminal output."""
    found: dict[str, str] = {}
    for candidate in _TUNNEL_URL_RE.findall(output):
        host = urlparse(candidate).hostname
        if not host or host in _PINGGY_CONTROL_HOSTS:
            continue
        if (
            host.endswith(".pinggy-free.link")
            or host.endswith(".free.pinggy.net")
            or host.endswith(".pinggy.io")
        ):
            scheme = urlparse(candidate).scheme
            found.setdefault(scheme, candidate)
    https_url = found.get("https")
    http_url  = found.get("http")
    return (https_url, http_url) if https_url and http_url else None


def _find_public_https_urls(output: str) -> list[str]:
    """Return all valid public Pinggy HTTPS URLs in order of appearance."""
    urls: list[str] = []
    for candidate in _TUNNEL_URL_RE.findall(output):
        parsed = urlparse(candidate)
        host   = parsed.hostname
        if parsed.scheme != "https" or not host or host in _PINGGY_CONTROL_HOSTS:
            continue
        if (
            host.endswith(".pinggy-free.link")
            or host.endswith(".free.pinggy.net")
            or host.endswith(".pinggy.io")
        ) and candidate not in urls:
            urls.append(candidate)
    return urls


class PinggyTunnel(BaseTunnel):
    """
    Opens a Pinggy HTTP tunnel with matching public HTTPS and HTTP URLs via SSH.
    Captures the public URL from PTY output. Auto-restarts if the tunnel drops.
    """

    def __init__(self, token: str, port: int = 8000):
        super().__init__(port)
        self._token                                  = token
        self._local_debugger_port                    = _pick_local_debugger_port()
        self._http_url: Optional[str]                = None
        self._last_debugger_error: Optional[str]     = None
        self._last_debugger_payload: Optional[str]   = None
        self._last_http_probe: Optional[str]         = None

    # ── Public API overrides ──────────────────────────────────────────────────

    def get_http_url(self) -> Optional[str]:
        with self._lock:
            return self._http_url

    def stop(self) -> None:
        super().stop()
        with self._lock:
            self._http_url = None

    # ── Internal ──────────────────────────────────────────────────────────────

    def _launch(self) -> str:
        # HTTP is Pinggy's default tunnel type — gives both public HTTP and HTTPS
        # URLs. Do NOT use x:https here: it redirects the plain-HTTP download URL
        # back to HTTPS, breaking native browser downloads.
        ssh_args = [
            "ssh", "-tt", "-p", "443",
            "-R", f"0:localhost:{self._port}",
            "-L", f"{self._local_debugger_port}:localhost:{_REMOTE_DEBUGGER_PORT}",
            "-o", "StrictHostKeyChecking=no",
            "-o", "ServerAliveInterval=30",
            "-o", "ExitOnForwardFailure=yes",
            f"{self._token}+force@free.pinggy.io",
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
            self._proc   = proc
            self._output = ""

        threading.Thread(
            target=self._capture_output, args=(proc,), daemon=True
        ).start()

        urls = self._wait_for_urls(proc)

        if not urls:
            proc.terminate()
            output = self._get_output().strip()
            if output:
                logger.log("error", f"Pinggy SSH output:\n{self._redact(output[-2_000:])}")
            else:
                logger.log("error", "Pinggy SSH produced no output")
            if self._last_debugger_error:
                logger.log("error", f"Pinggy debugger URL lookup failed: {self._last_debugger_error}")
            elif self._last_debugger_payload is not None:
                logger.log("error", f"Pinggy debugger URLs: {self._last_debugger_payload}")
            raise RuntimeError(
                f"Pinggy tunnel did not provide a URL within {_URL_TIMEOUT}s. "
                "Check your Pinggy token."
            )

        url, http_url = urls

        with self._lock:
            self._url      = url
            self._http_url = http_url

        logger.log("info", f"Pinggy tunnel ready: {url}")
        if http_url:
            logger.log("info", f"Pinggy HTTP tunnel ready: {http_url}")
        else:
            logger.log(
                "warning",
                "Pinggy did not provide a usable HTTP tunnel URL; "
                "native browser downloads are unavailable for this tunnel",
            )
            if self._last_http_probe:
                logger.log("warning", f"Pinggy HTTP probe: {self._last_http_probe}")

        if self._on_url_change:
            try:
                self._on_url_change(url)
            except Exception as e:
                logger.log("warning", f"URL change callback error: {e}")

        return url

    def _watchdog(self) -> None:
        """Extends base watchdog to also clear ``_http_url`` on restart."""
        while True:
            with self._lock:
                proc = self._proc

            if proc is None:
                return

            proc.wait()

            with self._lock:
                if self._proc is None:
                    return
                logger.log(
                    "warning",
                    f"Pinggy tunnel exited, restarting in {_RESTART_DELAY}s...",
                )
                self._url      = None
                self._http_url = None

            time.sleep(_RESTART_DELAY)

            try:
                new_url = self._launch()
                logger.log("info", f"Pinggy tunnel restarted: {new_url}")
            except Exception as e:
                logger.log("error", f"Failed to restart Pinggy tunnel: {e}")
                time.sleep(_RESTART_DELAY * 2)

    def _wait_for_urls(
        self, proc: subprocess.Popen
    ) -> Optional[tuple[str, Optional[str]]]:
        """Find HTTPS quickly; verify the matching HTTP URL as soon as Pinggy exposes it."""
        deadline            = time.time() + _URL_TIMEOUT
        first_https_url: Optional[str]   = None
        first_https_seen_at: Optional[float] = None

        while time.time() < deadline:
            time.sleep(_POLL_INTERVAL)

            if proc.poll() is not None:
                logger.log("error", "Pinggy SSH process exited early")
                return None

            content   = _strip_ansi_pinggy(self._get_output())
            urls      = _find_public_tunnel_urls(content)
            if urls:
                return urls
            https_urls = _find_public_https_urls(content)

            # The debugger API is more reliable than scraping SSH terminal
            # output and returns both HTTP and HTTPS tunnel URLs.
            urls = self._get_debugger_urls()
            if urls:
                return urls
            https_urls.extend(
                _find_public_https_urls(self._last_debugger_payload or "")
            )

            if https_urls and not first_https_url:
                first_https_url      = https_urls[0]
                first_https_seen_at  = time.time()

            for https_url in dict.fromkeys(https_urls):
                http_url = self._probe_http_url(https_url)
                if http_url:
                    return https_url, http_url

            if first_https_url and first_https_seen_at and (
                time.time() - first_https_seen_at >= _HTTP_URL_DISCOVERY_TIMEOUT
            ):
                return first_https_url, None

        return None

    def _get_debugger_urls(self) -> Optional[tuple[str, str]]:
        try:
            with urlopen(
                f"http://127.0.0.1:{self._local_debugger_port}/urls", timeout=1
            ) as response:
                payload = json.loads(response.read().decode("utf-8"))
            urls = payload.get("urls", []) if isinstance(payload, dict) else []
            self._last_debugger_payload = json.dumps(urls)
            self._last_debugger_error   = None
            return _find_public_tunnel_urls("\n".join(urls))
        except Exception as error:
            self._last_debugger_error = f"{type(error).__name__}: {error}"
            return None

    def _probe_http_url(self, https_url: str) -> Optional[str]:
        """Return the HTTP URL only when Pinggy actually serves it over HTTP."""
        parsed = urlparse(https_url)
        if not parsed.hostname:
            return None
        http_url = f"http://{parsed.netloc}"
        try:
            request = Request(
                f"{http_url}/health",
                headers={"User-Agent": "StreamLift-Worker/1.0"},
            )
            with urlopen(request, timeout=2) as response:
                final_url = response.geturl()
            if urlparse(final_url).scheme == "http":
                self._last_http_probe = None
                return http_url
            self._last_http_probe = f"{http_url} redirects to {final_url}"
        except Exception as error:
            self._last_http_probe = (
                f"{http_url} failed ({type(error).__name__}: {error})"
            )
        return None

    def _redact(self, text: str) -> str:
        return text.replace(self._token, "[REDACTED]")
