"""
In-process log queue.

Two data structures:
- _queue: consumed by flush_logs (sent to backend) — kept for compat but no longer called
- _ring:  a fixed-size ring buffer (max 50 entries) for SSE streaming — never consumed
"""

from datetime import datetime, timezone
from typing import Any

from streamlift_worker.config import MAX_LOG_QUEUE

# Queue consumed by flush_logs (legacy — no longer actively used in v2)
_queue: list[dict[str, Any]] = []

# Ring buffer for SSE — always holds the latest MAX_LOG_QUEUE entries
_ring:  list[dict[str, Any]] = []


def log(level: str, message: str) -> None:
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "level":     level,
        "message":   message,
    }
    print(f"[{entry['timestamp']}] [{level.upper():7s}] {message}", flush=True)

    _queue.append(entry)
    if len(_queue) > MAX_LOG_QUEUE:
        del _queue[:-MAX_LOG_QUEUE]

    # Also append to ring buffer — never consumed, always available for SSE
    _ring.append(entry)
    if len(_ring) > MAX_LOG_QUEUE:
        del _ring[:-MAX_LOG_QUEUE]


def pop_batch(n: int = 10) -> list[dict[str, Any]]:
    """Return up to n entries and remove them from the send queue."""
    batch = _queue[:n]
    del _queue[:n]
    return batch


def peek_recent(n: int = 20) -> list[dict[str, Any]]:
    """Return the most recent n log entries without consuming them — used for SSE."""
    return list(_ring[-n:])


def pending_count() -> int:
    return len(_queue)
