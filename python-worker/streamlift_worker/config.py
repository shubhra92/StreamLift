"""
Worker configuration — populated entirely from CLI args.
No .env file needed; the user just runs the one-liner from the UI.
"""

import time
from dataclasses import dataclass, field
from typing import Literal

# Process start time — used for uptime calculation in heartbeat and SSE stream
START_TIME = time.time()

ComputeType      = Literal["low", "medium", "high"]
DownloadLocation = Literal["local", "mega"]

COMPUTE_CONFIG = {
    "low":    {"max_cpu_pct": 25,  "chunk_size": 512  * 1024},   # 512 KB
    "medium": {"max_cpu_pct": 50,  "chunk_size": 1024 * 1024},   # 1 MB
    "high":   {"max_cpu_pct": 100, "chunk_size": 2048 * 1024},   # 2 MB
}

MAX_RETRIES        = 3
RETRY_DELAY        = 5    # seconds, multiplied by attempt number
MAX_LOG_QUEUE      = 50
HEARTBEAT_INTERVAL = 8    # background heartbeat thread interval (seconds)
SERVER_PORT        = 8000


@dataclass
class WorkerConfig:
    worker_id:         str
    auth_token:        str
    api_base_url:      str
    compute_type:      ComputeType
    download_location: DownloadLocation
    pinggy_token:      str = ""
    mega_email:        str = ""
    mega_password:     str = ""
    worker_version:    str = "1.1.0"
    server_port:       int = SERVER_PORT

    @property
    def chunk_size(self) -> int:
        return COMPUTE_CONFIG[self.compute_type]["chunk_size"]
