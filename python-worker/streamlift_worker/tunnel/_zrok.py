"""
ZrokTunnel — HTTPS reverse tunnel via zrok (myzrok.io).

zrok is a token-based tunnel that requires:
  1. The ``zrok`` binary installed in the environment (``pip install zrok`` or
     download from https://github.com/openziti/zrok/releases).
  2. An account token from https://myzrok.io (free tier available).

On first use the worker runs ``zrok enable <token>`` to register the environment,
then ``zrok share public --headless --backend-mode proxy <port>`` to open the
tunnel. The public URL is printed to stdout:
  https://abc123.share.zrok.io
or (v2+):
  https://abc123.shares.zrok.io

The token is stored encrypted in tunnel_config by the backend and passed to the
worker at boot via /api/worker/config. It never appears in process listings
because it is passed via the ZROK_ENABLE_TOKEN environment variable where possible.

Free-tier public shares still show zrok's interstitial page to browser
user-agents, even when the share is created with ``--open``. Browser clients
must send ``skip_zrok_interstitial: 1`` to reach the worker (see
``next-frontend/app/lib/tunnelHeaders.ts``). ``--open`` only disables zrok's
closed/OAuth permission mode; the interstitial is enabled per account via
``skip_interstitial_grants``, not per share.
"""

import os
import re
import shutil
import subprocess
import threading
import time
from typing import Optional

from streamlift_worker import logger
from streamlift_worker.tunnel._base import BaseTunnel, _MAX_CAPTURED_OUTPUT, _RESTART_DELAY

# ── zrok-specific constants ───────────────────────────────────────────────────

# zrok v2 logs the share hostname inside a structured JSON log line:
#   {"msg":"access your zrok share at the following endpoints:\n g0hs1l4byfst.shares.zrok.io"}
# The hostname appears WITHOUT https:// prefix in the msg field.
# We also accept a plain https:// URL in case future versions add it.
_ZROK_HOST_RE = re.compile(r"([A-Za-z0-9-]+\.shares?\.zrok\.io)")
_ZROK_URL_RE  = re.compile(r"https://[A-Za-z0-9-]+\.shares?\.zrok\.io")
_ZROK_URL_TIMEOUT = 90    # zrok enable + share startup can take a while
_ZROK_POLL        = 0.5   # seconds between polls

# Binary name candidates (zrok v1 is "zrok", v2 ships as "zrok2" on some distros)
_ZROK_BIN_CANDIDATES = ("zrok", "zrok2")


def _find_zrok_binary() -> str:
    """Return the zrok binary path, auto-downloading the CLI binary if not found."""
    for name in _ZROK_BIN_CANDIDATES:
        path = shutil.which(name)
        if path:
            return path

    # Not on PATH — download the pre-built Go binary from GitHub releases.
    # The pip 'zrok' package is the Python SDK only, not the CLI binary.
    logger.log("info", "zrok CLI binary not found — downloading from GitHub releases...")
    try:
        _install_zrok_binary()
    except Exception as e:
        logger.log("warning", f"zrok binary download failed: {e}")

    # Retry after download
    for name in _ZROK_BIN_CANDIDATES:
        path = shutil.which(name)
        if path:
            return path

    # Also check /usr/local/bin directly (may not be on PATH in all envs)
    for name in _ZROK_BIN_CANDIDATES:
        candidate = f"/usr/local/bin/{name}"
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate

    raise RuntimeError(
        "zrok CLI binary not found after attempting automatic download.\n"
        "Install it manually in your environment:\n"
        "  curl -sSL https://get.openziti.io/zrok-install.bash | bash\n"
        "or download from https://github.com/openziti/zrok/releases\n"
        "then restart the worker."
    )


def _install_zrok_binary() -> None:
    """Download the latest zrok Linux binary from GitHub and place it in /usr/local/bin."""
    import urllib.request
    import tarfile
    import tempfile
    import json as _json

    # Resolve latest release version via GitHub API
    api_url = "https://api.github.com/repos/openziti/zrok/releases/latest"
    with urllib.request.urlopen(api_url, timeout=15) as resp:  # noqa: S310
        release = _json.loads(resp.read().decode())
    tag = release["tag_name"]           # e.g. "v1.1.11"
    version = tag.lstrip("v")           # e.g. "1.1.11"

    # Detect architecture
    import platform
    machine = platform.machine().lower()
    arch = "amd64" if machine in ("x86_64", "amd64") else "arm64"

    tarball_name = f"zrok_{version}_linux_{arch}.tar.gz"
    download_url = (
        f"https://github.com/openziti/zrok/releases/download/{tag}/{tarball_name}"
    )

    logger.log("info", f"Downloading zrok {tag} ({arch}) from GitHub...")

    with tempfile.TemporaryDirectory() as tmpdir:
        tarball_path = os.path.join(tmpdir, tarball_name)

        # Download
        urllib.request.urlretrieve(download_url, tarball_path)  # noqa: S310

        # Extract the binary — v1 ships as 'zrok', v2 ships as 'zrok2'
        extracted_name = None
        with tarfile.open(tarball_path, "r:gz") as tar:
            members = tar.getmembers()
            # find the binary: prefer zrok2, fall back to zrok
            binary_member = None
            for preferred in ("zrok2", "zrok"):
                for member in members:
                    basename = os.path.basename(member.name)
                    if basename == preferred and not member.isdir():
                        binary_member = member
                        extracted_name = preferred
                        break
                if binary_member:
                    break

            if not binary_member:
                names = [m.name for m in members]
                raise RuntimeError(f"No zrok binary found in tarball. Contents: {names}")

            binary_member.name = extracted_name  # flatten path
            tar.extract(binary_member, tmpdir)

        # Install to /usr/local/bin under the extracted name
        src = os.path.join(tmpdir, extracted_name)
        dst = f"/usr/local/bin/{extracted_name}"
        if os.path.isfile(src):
            import stat
            shutil.copy2(src, dst)
            os.chmod(dst, os.stat(dst).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            logger.log("info", f"zrok binary installed at {dst} (command: {extracted_name})")
        else:
            raise RuntimeError(f"Extraction failed — {src} not found")


class ZrokTunnel(BaseTunnel):
    """
    Opens a zrok public HTTPS share.

    Parameters
    ----------
    token:
        zrok account token from https://myzrok.io. Used to enable the
        environment; stored encrypted in the DB and passed at boot.
    port:
        Local port the FastAPI worker listens on (default 8000).
    """

    def __init__(self, token: str, port: int = 8000):
        super().__init__(port)
        self._token = token

    # ── Internal ──────────────────────────────────────────────────────────────

    def _launch(self) -> str:
        binary = _find_zrok_binary()

        # Step 1: enable the zrok environment (idempotent — safe to re-run)
        env = {**__import__("os").environ, "ZROK_ENABLE_TOKEN": self._token}
        logger.log("info", "Enabling zrok environment...")
        try:
            result = subprocess.run(
                [binary, "enable", self._token],
                capture_output=True,
                text=True,
                timeout=30,
                env=env,
            )
            # "already enabled" is not an error
            if result.returncode != 0:
                stderr = result.stderr.strip()
                if "already enabled" not in stderr.lower() and "already exists" not in stderr.lower():
                    logger.log("warning", f"zrok enable: {stderr[:500]}")
        except subprocess.TimeoutExpired:
            logger.log("warning", "zrok enable timed out — environment may already be enabled, continuing...")

        # Step 2: open the public share
        # --open:     disable zrok's closed permission mode so anonymous
        #             clients are not sent through OAuth/basic auth. It does
        #             NOT disable the free-tier interstitial: browser clients
        #             must send `skip_zrok_interstitial: 1` (see
        #             next-frontend/app/lib/tunnelHeaders.ts). OPTIONS
        #             preflights bypass the interstitial, so CORS preflight
        #             still reaches FastAPI directly.
        share_args = [
            binary, "share", "public",
            "--headless",
            "--open",
            "--backend-mode", "proxy",
            f"http://127.0.0.1:{self._port}",
        ]

        logger.log("info", f"Starting zrok public share on port {self._port}...")

        proc = subprocess.Popen(
            share_args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
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
            output = self._get_output().strip()
            if output:
                logger.log("error", f"zrok output:\n{output[-2_000:]}")
            else:
                logger.log("error", "zrok produced no output")
            raise RuntimeError(
                f"zrok tunnel did not provide a URL within {_ZROK_URL_TIMEOUT}s. "
                "Check your zrok account token and that the binary is installed correctly."
            )

        with self._lock:
            self._url = url

        logger.log("info", f"zrok tunnel ready: {url}")

        if self._on_url_change:
            try:
                self._on_url_change(url)
            except Exception as e:
                logger.log("warning", f"URL change callback error: {e}")

        return url

    def _wait_for_url(self, proc: subprocess.Popen) -> Optional[str]:
        deadline = time.time() + _ZROK_URL_TIMEOUT
        while time.time() < deadline:
            time.sleep(_ZROK_POLL)

            if proc.poll() is not None:
                logger.log("error", "zrok process exited early")
                return None

            output = self._get_output()

            # Try full https:// URL first (future versions may include it)
            match = _ZROK_URL_RE.search(output)
            if match:
                return match.group(0)

            # v2 logs just the bare hostname inside a JSON msg field — prepend scheme
            match = _ZROK_HOST_RE.search(output)
            if match:
                return f"https://{match.group(1)}"

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

    def _redact(self, text: str) -> str:
        return text.replace(self._token, "[REDACTED]")
