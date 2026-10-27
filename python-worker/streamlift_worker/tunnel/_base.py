"""
BaseTunnel — shared state, lifecycle, and watchdog for all tunnel providers.

Each provider subclass implements ``_launch() -> str`` which starts its specific
SSH/binary process and blocks until it has a public HTTPS URL to return.
Everything else — output capture, thread-safe state, watchdog restart — lives
here so it isn't copy-pasted across providers.
"""

import subprocess
import threading
import time
from abc import ABC, abstractmethod
from typing import Optional

from streamlift_worker import logger

# Shared across all providers
_RESTART_DELAY       = 5        # seconds before restarting after unexpected exit
_MAX_CAPTURED_OUTPUT = 12_000   # bytes of SSH output kept in memory


class BaseTunnel(ABC):
    """
    Abstract base for SSH-based tunnel providers.

    Subclasses must implement ``_launch()`` which starts the tunnel process,
    waits for a public URL, stores it in ``self._url``, and returns it.
    The watchdog and output-capture machinery is provided here.
    """

    def __init__(self, port: int = 8000):
        self._port  = port
        self._url:  Optional[str]              = None
        self._proc: Optional[subprocess.Popen] = None
        self._lock  = threading.Lock()
        self._on_url_change                    = None
        self._output                           = ""

    # ── Public API ────────────────────────────────────────────────────────────

    def start(self) -> str:
        """Start the tunnel; block until the public HTTPS URL is ready."""
        url = self._launch()
        threading.Thread(target=self._watchdog, daemon=True).start()
        return url

    def get_url(self) -> Optional[str]:
        with self._lock:
            return self._url

    def get_http_url(self) -> Optional[str]:
        """HTTP counterpart of the tunnel URL. Most providers return None."""
        return None

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

    # ── Internal helpers (shared) ─────────────────────────────────────────────

    def _capture_output(self, proc: subprocess.Popen) -> None:
        """Read the process stdout continuously; prevents a full pipe from blocking."""
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

    def _watchdog(self) -> None:
        """Restart the tunnel automatically when the process exits unexpectedly."""
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
                    f"{self.__class__.__name__} exited, "
                    f"restarting in {_RESTART_DELAY}s...",
                )
                self._url = None

            time.sleep(_RESTART_DELAY)

            try:
                new_url = self._launch()
                logger.log("info", f"{self.__class__.__name__} restarted: {new_url}")
            except Exception as e:
                logger.log(
                    "error",
                    f"Failed to restart {self.__class__.__name__}: {e}",
                )
                time.sleep(_RESTART_DELAY * 2)

    # ── Abstract ──────────────────────────────────────────────────────────────

    @abstractmethod
    def _launch(self) -> str:
        """
        Start the tunnel process, wait for the public URL, store it in
        ``self._url``, fire ``self._on_url_change`` if set, and return the URL.
        Must raise ``RuntimeError`` on failure.
        """
