"""
Worker startup orchestration.

Boot sequence:
  1. Validate Mega credentials (if location=mega)
  2. Start FastAPI server in a background thread
  3. Start tunnel (Pinggy/Serveo/zrok) — get public URL
  4. Register with Next.js backend — get session token
  5. Initialise FastAPI server state with session token
  6. Start heartbeat background thread
  7. Block main thread (server handles all work via API now)

The tunnel can be hot-swapped at runtime: the dashboard queues a "Restart
tunnel" request in the worker config, the heartbeat sees a new nonce, and a
background thread starts the new tunnel before stopping the old one. The
FastAPI server, active downloads and the Python process are never restarted.
"""

import sys
import threading
import time
from dataclasses import replace
from typing import Optional

import uvicorn

from streamlift_worker import api, logger
from streamlift_worker.config import HEARTBEAT_INTERVAL, WorkerConfig, START_TIME
from streamlift_worker.mega import get_mega_client
from streamlift_worker.metrics import get_public_ip, get_system_metrics
from streamlift_worker.server import (
    app,
    init_server,
    update_public_http_url,
    update_session_token,
)
from streamlift_worker.tunnel import PinggyTunnel, ServeoTunnel, ZrokTunnel

Tunnel = PinggyTunnel | ServeoTunnel | ZrokTunnel

# After a failed hot-swap, don't hammer the provider on every heartbeat. A new
# nonce (user clicks "Restart tunnel" again) retries immediately.
_RESTART_RETRY_SECONDS = 60

# Shared task state — written by downloader.py, read by server.py
_current_task: dict = {}


def _create_tunnel(config: WorkerConfig) -> Tunnel:
    """Build the tunnel provider described by ``config``.

    Raises ``RuntimeError`` when the selected provider is missing a required
    credential. At boot that ends the process; during a hot-swap it leaves the
    existing tunnel untouched.
    """
    if config.tunnel_provider == "serveo":
        logger.log("info", "Tunnel provider: Serveo (HTTPS only, no token required)")
        return ServeoTunnel(port=config.server_port)

    if config.tunnel_provider == "zrok":
        if not config.zrok_token:
            raise RuntimeError(
                "No zrok token found — pass --zrok-token or set it in the worker config."
            )
        logger.log("info", "Tunnel provider: zrok")
        return ZrokTunnel(token=config.zrok_token, port=config.server_port)

    if not config.pinggy_token:
        raise RuntimeError(
            "No Pinggy token found — pass --pinggy-token or make sure it's set in the worker config."
        )
    logger.log("info", "Tunnel provider: Pinggy")
    return PinggyTunnel(token=config.pinggy_token, port=config.server_port)


class TunnelManager:
    """Owns the current tunnel and hot-swaps it when the dashboard requests it."""

    def __init__(self, config: WorkerConfig, public_ip: str):
        self._config        = config
        self._public_ip     = public_ip
        self._tunnel: Optional[Tunnel] = None
        self._lock          = threading.RLock()
        self._swapping      = False
        self._restart_nonce = config.tunnel_restart_nonce
        self._failed_nonce: Optional[str] = None
        self._retry_after   = 0.0

    # ── Public API ────────────────────────────────────────────────────────────

    def start(self) -> str:
        """Start the initial tunnel and return its public HTTPS URL."""
        tunnel = _create_tunnel(self._config)
        url = tunnel.start()
        with self._lock:
            self._tunnel = tunnel
        tunnel.on_url_change(self._make_url_change_handler(tunnel))
        return url

    def current(self) -> Optional[Tunnel]:
        with self._lock:
            return self._tunnel

    def stop(self) -> None:
        with self._lock:
            tunnel = self._tunnel
            self._tunnel = None
        if tunnel is not None:
            tunnel.stop()

    def maybe_restart(self, remote_nonce: Optional[str]) -> None:
        """Apply a queued restart request from the backend heartbeat."""
        if not remote_nonce or remote_nonce == self._restart_nonce:
            return
        with self._lock:
            if self._swapping:
                return
            if remote_nonce == self._failed_nonce and time.time() < self._retry_after:
                return
            self._swapping = True

        threading.Thread(
            target=self._restart,
            args=(remote_nonce,),
            daemon=True,
        ).start()

    # ── Internals ─────────────────────────────────────────────────────────────

    def _restart(self, nonce: str) -> None:
        new_tunnel: Optional[Tunnel] = None
        try:
            logger.log("info", "Tunnel restart requested — fetching latest tunnel config...")
            remote = api.fetch_worker_config(
                self._config.worker_id,
                self._config.auth_token,
                self._config.api_base_url,
            )
            if not remote:
                raise RuntimeError("could not fetch the worker config from the backend")

            new_config = replace(self._config)
            self._apply_remote_tunnel_config(new_config, remote)

            new_tunnel = _create_tunnel(new_config)
            new_url = new_tunnel.start()

            # Shutdown may have started while the provider was connecting.
            if api.stop_event.is_set():
                new_tunnel.stop()
                return

            with self._lock:
                old_tunnel = self._tunnel
                self._tunnel = new_tunnel
            self._adopt_tunnel_config(new_config)

            new_tunnel.on_url_change(self._make_url_change_handler(new_tunnel))
            if old_tunnel is not None:
                old_tunnel.stop()

            update_public_http_url(new_tunnel.get_http_url())

            session_token = api.register(self._config, self._public_ip, new_url)
            if session_token:
                update_session_token(session_token)
            else:
                logger.log(
                    "error",
                    "Tunnel is live but re-registration failed; "
                    "the next heartbeat will publish the new URL",
                )

            self._restart_nonce = nonce
            self._failed_nonce  = None
            self._retry_after   = 0.0
            logger.log("info", f"Tunnel restarted without restarting the worker: {new_url}")
        except Exception as e:
            if new_tunnel is not None:
                try:
                    new_tunnel.stop()
                except Exception:
                    pass
            self._failed_nonce = nonce
            self._retry_after  = time.time() + _RESTART_RETRY_SECONDS
            logger.log("error", f"Tunnel restart failed; keeping the existing tunnel: {e}")
        finally:
            with self._lock:
                self._swapping = False

    def _apply_remote_tunnel_config(self, config: WorkerConfig, remote: dict) -> None:
        """Copy only tunnel-related fields — compute/location require a restart."""
        provider = remote.get("tunnelProvider")
        if provider in ("pinggy", "serveo", "zrok"):
            config.tunnel_provider = provider

        if "pinggyToken" in remote:
            config.pinggy_token = remote.get("pinggyToken") or ""
        if "zrokToken" in remote:
            config.zrok_token = remote.get("zrokToken") or ""

    def _adopt_tunnel_config(self, new_config: WorkerConfig) -> None:
        """Apply a successfully-started tunnel config to the shared WorkerConfig."""
        self._config.tunnel_provider = new_config.tunnel_provider
        self._config.pinggy_token    = new_config.pinggy_token
        self._config.zrok_token      = new_config.zrok_token

    def _make_url_change_handler(self, tunnel: Tunnel):
        """Re-register when a tunnel's watchdog reconnects it."""

        def handler(new_url: str) -> None:
            with self._lock:
                if self._tunnel is not tunnel:
                    return
            logger.log("info", f"Tunnel URL changed to {new_url}, re-registering...")
            update_public_http_url(tunnel.get_http_url())
            session_token = api.register(self._config, self._public_ip, new_url)
            if session_token:
                update_session_token(session_token)
                logger.log("info", "Worker session token refreshed after tunnel renewal")
            else:
                logger.log("error", "Worker re-registration failed; tunnel URL was not updated")

        return handler


def _heartbeat_loop(config: WorkerConfig, manager: TunnelManager) -> None:
    while not api.stop_event.is_set():
        try:
            tunnel = manager.current()
            tunnel_url = (tunnel.get_url() if tunnel else None) or ""
            metrics = get_system_metrics()
            response = api.heartbeat(
                config, metrics, tunnel_url, int(time.time() - START_TIME)
            )
            if response:
                manager.maybe_restart(response.get("tunnelRestartNonce"))
        except Exception as e:
            logger.log("warning", f"Heartbeat error: {e}")
        api.stop_event.wait(timeout=HEARTBEAT_INTERVAL)


def _start_uvicorn(config: WorkerConfig) -> None:
    """Run the FastAPI server in a background daemon thread."""
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=config.server_port,
        log_level="warning",
        # HTTP/1.1 is required for SSE — HTTP/2 multiplexing can break SSE
        # through proxies like Pinggy
        http="h11",
    )


def run(config: WorkerConfig) -> None:
    from streamlift_worker import __version__
    logger.log("info", f"StreamLift Worker v{__version__} starting")
    logger.log("info", f"Compute type     : {config.compute_type}")
    logger.log("info", f"Download location: {config.download_location}")
    logger.log("info", f"API base URL     : {config.api_base_url}")
    logger.log("info", f"Server port      : {config.server_port}")

    # ── Step 1: Validate Mega credentials early ───────────────────────────────
    if config.download_location == "mega":
        try:
            get_mega_client(config)
        except Exception as e:
            logger.log("error", f"Mega setup failed: {e}")
            logger.log("error", "Fix credentials and re-run the worker command.")
            sys.exit(1)

    # ── Step 2: Start FastAPI server in background ────────────────────────────
    logger.log("info", f"Starting FastAPI server on port {config.server_port}...")
    server_thread = threading.Thread(
        target=_start_uvicorn, args=(config,), daemon=True
    )
    server_thread.start()
    time.sleep(1)  # give uvicorn a moment to bind the port
    logger.log("info", "FastAPI server started")

    # ── Step 3: Start tunnel ──────────────────────────────────────────────────
    ip = get_public_ip()
    manager = TunnelManager(config, ip)
    try:
        public_url = manager.start()
    except RuntimeError as e:
        logger.log("error", f"Tunnel failed: {e}")
        sys.exit(1)

    # ── Step 4: Register with backend ────────────────────────────────────────
    session_token = api.register(config, ip, public_url)
    if session_token is None:
        manager.stop()
        sys.exit(1)

    # ── Step 5: Initialise FastAPI server state ───────────────────────────────
    tunnel = manager.current()
    init_server(config, _current_task, session_token, tunnel.get_http_url() if tunnel else None)
    logger.log("info", "Worker API ready and accepting connections")
    logger.log("info", f"Public URL: {public_url}")
    if tunnel and tunnel.get_http_url():
        logger.log("info", f"Public HTTP download URL: {tunnel.get_http_url()}")
    else:
        logger.log("info", "HTTP download URL: not available for this tunnel provider")

    # ── Step 6: Start heartbeat thread ────────────────────────────────────────
    hb = threading.Thread(
        target=_heartbeat_loop, args=(config, manager), daemon=True
    )
    hb.start()
    logger.log("info", "Background heartbeat thread started")

    # ── Step 7: Block — server handles everything from here ───────────────────
    try:
        while not api.stop_event.is_set():
            api.stop_event.wait(timeout=60)
    except KeyboardInterrupt:
        logger.log("info", "Worker stopped by user.")
        api.stop_event.set()
    finally:
        manager.stop()
