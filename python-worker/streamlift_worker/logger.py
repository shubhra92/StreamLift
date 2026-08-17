"""
In-process fixed-size ring buffer for direct worker SSE streaming.
"""

from datetime import datetime, timezone
from typing import Any

from streamlift_worker.config import MAX_LOG_QUEUE

# Ring buffer for SSE — always holds the latest MAX_LOG_QUEUE entries
_ring:  list[dict[str, Any]] = []


def log(level: str, message: str) -> None:
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "level":     level,
        "message":   message,
    }
    print(f"[{entry['timestamp']}] [{level.upper():7s}] {message}", flush=True)

    _ring.append(entry)
    if len(_ring) > MAX_LOG_QUEUE:
        del _ring[:-MAX_LOG_QUEUE]


def peek_recent(n: int = 20) -> list[dict[str, Any]]:
    """Return the most recent n log entries without consuming them — used for SSE."""
    return list(_ring[-n:])
