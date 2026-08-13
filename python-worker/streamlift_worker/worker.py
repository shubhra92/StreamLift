"""
Main worker loop — registration, heartbeat thread, and task dispatch.
"""

import sys
import threading
import time
from typing import Optional

from streamlift_worker import api, logger
from streamlift_worker.config import HEARTBEAT_INTERVAL, POLL_INTERVAL, WorkerConfig
from streamlift_worker.downloader import process_http_download, process_torrent_download
from streamlift_worker.mega import get_mega_client
from streamlift_worker.metrics import get_public_ip, get_system_metrics

# Shared mutable dict so the heartbeat thread can report what's running
_current_task: dict = {}


def _heartbeat_loop(config: WorkerConfig) -> None:
    while not api.stop_event.is_set():
        try:
            metrics = get_system_metrics()
            api.heartbeat(config, _current_task or None, metrics)
            api.flush_logs(config)
        except Exception as e:
            logger.log("warning", f"Background heartbeat error: {e}")
        api.stop_event.wait(timeout=HEARTBEAT_INTERVAL)


def run(config: WorkerConfig) -> None:
    from streamlift_worker import __version__
    logger.log("info", f"StreamLift Worker v{__version__} starting")
    logger.log("info", f"Compute type     : {config.compute_type}")
    logger.log("info", f"Download location: {config.download_location}")
    logger.log("info", f"API base URL     : {config.api_base_url}")

    # Fail fast — verify Mega credentials before accepting any tasks
    if config.download_location == "mega":
        try:
            get_mega_client(config)
        except Exception as e:
            logger.log("error", f"Mega setup failed: {e}")
            logger.log("error", "Fix credentials and re-run the worker command.")
            sys.exit(1)

    ip = get_public_ip()
    if not api.register(config, ip):
        sys.exit(1)

    hb = threading.Thread(target=_heartbeat_loop, args=(config,), daemon=True)
    hb.start()
    logger.log("info", "Background heartbeat thread started")

    while not api.stop_event.is_set():
        try:
            metrics = get_system_metrics()
            result  = api.heartbeat(config, _current_task or None, metrics)

            if result and result.get("success"):
                for task in result.get("newTasks", []):
                    dtype = task.get("downloadType", "http")
                    logger.log("info", f"New task: {task.get('fileName', '?')} [{dtype}]")
                    if dtype == "torrent":
                        process_torrent_download(config, task, _current_task)
                    else:
                        process_http_download(config, task, _current_task)

            api.flush_logs(config)
            api.stop_event.wait(timeout=POLL_INTERVAL)

        except KeyboardInterrupt:
            logger.log("info", "Worker stopped by user.")
            api.stop_event.set()
            break
        except Exception as e:
            logger.log("error", f"Unexpected error in main loop: {e}")
            api.stop_event.wait(timeout=POLL_INTERVAL)
