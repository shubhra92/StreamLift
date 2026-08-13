"""
Worker configuration — populated entirely from CLI args.
No .env file needed; the user just runs the one-liner from the UI.
"""

from dataclasses import dataclass
from typing import Literal

ComputeType      = Literal["low", "medium", "high"]
DownloadLocation = Literal["local", "mega"]

COMPUTE_CONFIG = {
    "low":    {"max_cpu_pct": 25,  "chunk_size": 512  * 1024},   # 512 KB
    "medium": {"max_cpu_pct": 50,  "chunk_size": 1024 * 1024},   # 1 MB
    "high":   {"max_cpu_pct": 100, "chunk_size": 2048 * 1024},   # 2 MB
}

POLL_INTERVAL      = 10   # seconds between main-loop polls
MAX_RETRIES        = 3
RETRY_DELAY        = 5    # seconds, multiplied by attempt number
MAX_LOG_QUEUE      = 50
HEARTBEAT_INTERVAL = 8    # background heartbeat thread interval (seconds)


@dataclass
class WorkerConfig:
    worker_id:         str
    auth_token:        str
    api_base_url:      str
    compute_type:      ComputeType
    download_location: DownloadLocation
    mega_email:        str = ""
    mega_password:     str = ""
    worker_version:    str = "1.1.0"

    @property
    def chunk_size(self) -> int:
        return COMPUTE_CONFIG[self.compute_type]["chunk_size"]
