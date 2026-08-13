"""
System metrics collection (CPU, RAM, network speed).
"""

import time
from datetime import datetime, timezone
from typing import Optional

import psutil

_net_snapshot: Optional[tuple[int, int, float]] = None


def get_system_metrics() -> dict:
    global _net_snapshot

    cpu = psutil.cpu_percent(interval=0.3)
    mem = psutil.virtual_memory().percent
    net = psutil.net_io_counters()
    now = time.time()

    dl_speed = ul_speed = 0.0
    if _net_snapshot is not None:
        prev_recv, prev_sent, prev_time = _net_snapshot
        elapsed  = max(now - prev_time, 0.001)
        dl_speed = max(0.0, (net.bytes_recv - prev_recv) / elapsed)
        ul_speed = max(0.0, (net.bytes_sent - prev_sent) / elapsed)

    _net_snapshot = (net.bytes_recv, net.bytes_sent, now)

    return {
        "cpuUsage":      round(cpu, 1),
        "ramUsage":      round(mem, 1),
        "downloadSpeed": round(dl_speed, 0),
        "uploadSpeed":   round(ul_speed, 0),
        "timestamp":     datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def get_public_ip() -> str:
    try:
        import requests
        r = requests.get("https://api.ipify.org?format=json", timeout=5)
        return r.json().get("ip", "unknown")
    except Exception:
        return "unknown"
