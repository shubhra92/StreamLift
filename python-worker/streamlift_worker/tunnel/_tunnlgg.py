"""
TunnlGgTunnel — free HTTPS reverse tunnel via tunnl.gg.

Uses the system SSH client with `output=json` so URL discovery reads a clean
JSON line instead of parsing terminal banners or QR codes.

Two modes:
  anonymous  (ssh_key_path="")        — random URL each reconnect, no credentials
  stable     (ssh_key_path="/path")   — same URL every time, derived from the SSH key.
             The key stays on the user's machine and is never sent to StreamLift.

Browser interstitial: tunnl.gg shows a warning page to browsers once per day.
API callers bypass it by sending ``tunnl-skip-browser-warning: 1``. Browsers
cannot attach that header to a CORS preflight, and tunnl.gg redirects browser
OPTIONS requests before the worker's CORS middleware sees them. The StreamLift
web client therefore reaches this tunnel through the same-origin Next.js proxy
(``/api/worker/<id>/proxy``); the Kotlin TV client and server-side token
rotation still call the tunnel directly with the bypass header. tunnl.gg Pro's
``cors=*`` option would remove this limitation, but it is not available on free
tunnels.

Note: tunnl.gg uses port 22 for SSH. If the environment blocks outbound port 22
(e.g. some Google Colab configurations), the tunnel will fail; use Serveo or
Pinggy instead as they run on port 443.
"""

import json
import re
import subprocess
import threading
import time
from typing import Optional

from streamlift_worker import logger
from streamlift_worker.tunnel._base import BaseTunnel, _MAX_CAPTURED_OUTPUT, _RESTART_DELAY

# ── tunnl.gg-specific constants ───────────────────────────────────────────────

# tunnl.gg emits one JSON object per line with output=json.
# First line is the tunnel event:
#   {"event":"tunnel","url":"https://happy-tiger-a1b2c3d4.tunnl.gg",...}
_TUNNLGG_URL_RE      = re.compile(r"https://[A-Za-z0-9-]+\.tunnl\.gg")
_TUNNLGG_URL_TIMEOUT = 30    # seconds to wait for the tunnel JSON line
_TUNNLGG_POLL        = 0.3   # seconds between polls


def _strip_ansi_tunnlgg(text: str) -> str:
    """Remove ANSI escape codes."""
    text = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', ' ', text)
    text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', ' ', text)
    return text


class TunnlGgTunnel(BaseTunnel):
    """
    Opens a tunnl.gg HTTPS tunnel via SSH.

    Parameters
    ----------
    ssh_key_path:
        Path to an SSH private key on the local machine.
        - Empty string (default): anonymous mode — random URL each reconnect.
        - File path (e.g. ``~/.ssh/id_ed25519``): stable mode — same URL tied
          to the key every time. The key file stays on the machine and is never
          uploaded to StreamLift.
    port:
        Local port the FastAPI worker listens on (default 8000).
    """

    def __init__(self, ssh_key_path: str = "", port: int = 8000):
        super().__init__(port)
        self._ssh_key_path = ssh_key_path.strip()

    # ── Internal ──────────────────────────────────────────────────────────────

    def _launch(self) -> str:
        # -T -n:         no TTY, no stdin — non-interactive, URL appears on stdout
        # output=json:   one JSON object per event line — no banner/QR to parse
        # stable@:       stable URL mode when an SSH key is provided
        # anonymous:     random URL when no key (omit stable@ username)
        user = "stable" if self._ssh_key_path else None
        host = "proxy.tunnl.gg"
        target = f"{user}@{host}" if user else host

        ssh_args = [
            "ssh",
            "-T", "-n",
            "-o", "StrictHostKeyChecking=no",
            "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=3",
            "-o", "ExitOnForwardFailure=yes",
            "-R", f"80:localhost:{self._port}",
        ]

        if self._ssh_key_path:
            import os
            expanded = os.path.expanduser(self._ssh_key_path)
            ssh_args += ["-i", expanded]

        ssh_args += [target, "output=json"]

        mode = f"stable (key: {self._ssh_key_path})" if self._ssh_key_path else "anonymous (random URL)"
        logger.log("info", f"Starting tunnl.gg HTTPS tunnel on port {self._port} [{mode}]...")

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
            output = _strip_ansi_tunnlgg(self._get_output()).strip()
            if output:
                logger.log("error", f"tunnl.gg SSH output:\n{output[-2_000:]}")
            else:
                logger.log("error", "tunnl.gg SSH produced no output")
            raise RuntimeError(
                f"tunnl.gg tunnel did not provide a URL within {_TUNNLGG_URL_TIMEOUT}s. "
                "tunnl.gg uses SSH port 22 — make sure it is not blocked. "
                + ("Check that the SSH key path is correct." if self._ssh_key_path else "")
            )

        with self._lock:
            self._url = url

        if self._ssh_key_path:
            logger.log("info", f"tunnl.gg stable tunnel ready: {url}")
        else:
            logger.log("info", f"tunnl.gg anonymous tunnel ready: {url} (URL changes on reconnect)")
        logger.log(
            "info",
            "tunnl.gg is HTTPS-only — HTTP download URL is not available. "
            "API callers must send 'tunnl-skip-browser-warning: 1'; the web "
            "dashboard uses the same-origin /api/worker/<id>/proxy.",
        )

        if self._on_url_change:
            try:
                self._on_url_change(url)
            except Exception as e:
                logger.log("warning", f"URL change callback error: {e}")

        return url

    def _wait_for_url(self, proc: subprocess.Popen) -> Optional[str]:
        deadline = time.time() + _TUNNLGG_URL_TIMEOUT
        while time.time() < deadline:
            time.sleep(_TUNNLGG_POLL)

            if proc.poll() is not None:
                logger.log("error", "tunnl.gg SSH process exited early")
                return None

            for line in _strip_ansi_tunnlgg(self._get_output()).splitlines():
                url = _parse_tunnlgg_json_line(line)
                if url:
                    return url

        return None

    def _capture_output(self, proc: subprocess.Popen) -> None:
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


def _parse_tunnlgg_json_line(line: str) -> Optional[str]:
    """Return the HTTPS URL from a tunnl.gg JSON tunnel event line, or None."""
    line = line.strip()
    if not line or not line.startswith("{"):
        return None
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return None
    if obj.get("event") != "tunnel":
        return None
    url = obj.get("url", "")
    if isinstance(url, str) and url.startswith("https://"):
        return url
    return None
