"""
ServeoTunnel — free HTTPS reverse tunnel via serveo.net.

Uses the system SSH client on port 443 — works in Google Colab and other
environments that block outbound port 22. No account, no token, no binary
needed. TLS is terminated by Serveo; the worker speaks plain HTTP locally.

Serveo shows a browser interstitial on free tunnels. API callers bypass it by
sending ``Bypass-Tunnel-Reminder: true``. The frontend derives this header
dynamically from the worker URL via ``tunnelHeaders.ts`` — no client code
needs to know about Serveo specifically.
"""

import re
import subprocess
import threading
import time
from typing import Optional

from streamlift_worker import logger
from streamlift_worker.tunnel._base import BaseTunnel, _MAX_CAPTURED_OUTPUT

# ── Serveo-specific constants ─────────────────────────────────────────────────

# Serveo prints the following line to stdout when the tunnel is ready:
#   Forwarding HTTP traffic from https://abc123.serveousercontent.com
# Assigned hostnames are under serveousercontent.com (not serveo.net), but we
# accept both to handle future changes gracefully.
_SERVEO_URL_RE      = re.compile(
    r"https://[A-Za-z0-9-]+\.serveo(?:usercontent\.com|\.net)"
)
_SERVEO_URL_TIMEOUT = 60    # seconds to wait for the forwarding line
_SERVEO_POLL        = 0.3   # seconds between output polls


def _strip_ansi_serveo(text: str) -> str:
    """Remove ANSI escape codes and non-printable control characters."""
    text = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', ' ', text)
    text = re.sub(r'\x1b[()][AB012]', '', text)
    text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', ' ', text)
    return text


class ServeoTunnel(BaseTunnel):
    """
    Opens a free HTTPS tunnel via serveo.net using only the system SSH client.

    Limitations of the free tier:
    - HTTPS only: ``get_http_url()`` always returns None.
    - Subdomains are assigned deterministically from the caller's IP, so they
      often stay stable within a single Colab session.
    - The watchdog restarts automatically and re-registers with the backend
      when the SSH connection drops.
    """

    # No extra __init__ needed — base class covers all shared state.

    # ── Internal ──────────────────────────────────────────────────────────────

    def _launch(self) -> str:
        # -p 443:  use HTTPS port instead of the commonly blocked port 22.
        # -R 80:…: Serveo forwards public HTTP/HTTPS to our local HTTP server.
        #          Serveo terminates TLS so the FastAPI server stays plain HTTP.
        # -T:      no pseudo-TTY — keeps stdout machine-readable. Serveo prints
        #          the URL to stdout only when -T is set (without it the process
        #          suspends on a tty-output stop signal in Colab).
        # NO -N:   -N suppresses the remote forwarding message entirely, so the
        #          URL line would never appear on stdout.
        ssh_args = [
            "ssh",
            "-p", "443",
            "-o", "StrictHostKeyChecking=no",
            "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=3",
            "-o", "ExitOnForwardFailure=yes",
            "-R", f"80:localhost:{self._port}",
            "-T",
            "serveo.net",
        ]

        logger.log(
            "info",
            f"Starting Serveo HTTPS tunnel on port {self._port} (via SSH port 443)...",
        )

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

        url = self._wait_for_url(proc)

        if not url:
            proc.terminate()
            output = _strip_ansi_serveo(self._get_output()).strip()
            if output:
                logger.log("error", f"Serveo SSH output:\n{output[-2_000:]}")
            else:
                logger.log("error", "Serveo SSH produced no output")
            raise RuntimeError(
                f"Serveo tunnel did not provide a URL within {_SERVEO_URL_TIMEOUT}s. "
                "Make sure SSH can reach serveo.net on port 443."
            )

        with self._lock:
            self._url = url

        logger.log("info", f"Serveo tunnel ready: {url}")
        logger.log(
            "info",
            "Serveo free tier is HTTPS-only — HTTP download URL is not available.",
        )

        if self._on_url_change:
            try:
                self._on_url_change(url)
            except Exception as e:
                logger.log("warning", f"URL change callback error: {e}")

        return url

    def _wait_for_url(self, proc: subprocess.Popen) -> Optional[str]:
        deadline = time.time() + _SERVEO_URL_TIMEOUT
        while time.time() < deadline:
            time.sleep(_SERVEO_POLL)

            if proc.poll() is not None:
                logger.log("error", "Serveo SSH process exited early")
                return None

            match = _SERVEO_URL_RE.search(_strip_ansi_serveo(self._get_output()))
            if match:
                return match.group(0)

        return None
