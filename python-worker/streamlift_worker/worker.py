"""
Worker startup orchestration.

Boot sequence:
  1. Validate Mega credentials (if location=mega)
  2. Start FastAPI server in a background thread
  3. Start Pinggy tunnel — get public URL
  4. Register with Next.js backend — get session token
  5. Initialise FastAPI server state with session token
  6. Start heartbeat background thread
  7. Block main thread (server handles all work via API now)
"""

import sys
import threading
import time

import uvicorn

from streamlift_worker import api, logger
from streamlift_worker.config import HEARTBEAT_INTERVAL, WorkerConfig
from streamlift_worker.mega import get_mega_client
from streamlift_worker.metrics import get_public_ip, get_system_metrics
from streamlift_worker.server import app, init_server, update_session_token
from streamlift_worker.tunnel import PinggyTunnel

# Shared task state — written by downloader.py, read by server.py
_current_task: dict = {}


def _heartbeat_loop(config: WorkerConfig, tunnel: PinggyTunnel) -> None:
    while not api.stop_event.is_set():
        try:
            pinggy_url = tunnel.get_url() or ""
            metrics    = get_system_metrics()
            api.heartbeat(config, metrics, pinggy_url)
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

    # ── Step 3: Start Pinggy tunnel ───────────────────────────────────────────
    if not config.pinggy_token:
        logger.log("error", "--pinggy-token is required to expose the worker API.")
        sys.exit(1)

    tunnel = PinggyTunnel(token=config.pinggy_token, port=config.server_port)

    try:
        pinggy_url = tunnel.start()
    except RuntimeError as e:
        logger.log("error", f"Pinggy tunnel failed: {e}")
        sys.exit(1)

    # ── Step 4: Register with backend ────────────────────────────────────────
    ip = get_public_ip()
    session_token = api.register(config, ip, pinggy_url)
    if session_token is None:
        sys.exit(1)

    # ── Step 5: Initialise FastAPI server state ───────────────────────────────
    init_server(config, _current_task, session_token)
    logger.log("info", "Worker API ready and accepting connections")
    logger.log("info", f"Public URL: {pinggy_url}")

    # Re-register with new URL whenever the tunnel restarts
    def _on_tunnel_url_change(new_url: str) -> None:
        logger.log("info", f"Tunnel URL changed to {new_url}, re-registering...")
        new_session_token = api.register(config, ip, new_url)
        if new_session_token:
            update_session_token(new_session_token)
            logger.log("info", "Worker session token refreshed after tunnel renewal")
        else:
            logger.log("error", "Worker re-registration failed; tunnel URL was not updated")

    tunnel.on_url_change(_on_tunnel_url_change)

    # ── Step 6: Start heartbeat thread ────────────────────────────────────────
    hb = threading.Thread(
        target=_heartbeat_loop, args=(config, tunnel), daemon=True
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
        tunnel.stop()
