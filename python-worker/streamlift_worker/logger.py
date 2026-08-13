"""
In-process log queue that buffers entries for batch-flush to the backend.
"""

from datetime import datetime, timezone
from typing import Any

from streamlift_worker.config import MAX_LOG_QUEUE

# Module-level queue — shared across the whole process
_queue: list[dict[str, Any]] = []


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


def pop_batch(n: int = 10) -> list[dict[str, Any]]:
    """Return up to n entries and remove them from the queue."""
    batch = _queue[:n]
    del _queue[:n]
    return batch


def pending_count() -> int:
    return len(_queue)
