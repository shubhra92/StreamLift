"""
Worker configuration — resolved from CLI flags plus the backend bootstrap
config (/api/worker/config) at startup. No .env file needed; the user just
runs the one-liner from the UI.
"""

import os
import time
from dataclasses import dataclass, field
from typing import Literal

# Process start time — used for uptime calculation in heartbeat and SSE stream
START_TIME = time.time()

ComputeType      = Literal["low", "medium", "high"]
DownloadLocation = Literal["local", "mega"]
TunnelProvider   = Literal["pinggy", "serveo", "tunnlgg", "zrok"]

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

# ── On-demand media playback (Watch page) ────────────────────────────────────
HLS_SEGMENT_SECONDS  = 6      # VOD segment length for transcoded playback
HLS_BATCH_SEGMENTS   = 20     # segments one background encoder run produces (120s)
HLS_SEGMENT_WAIT     = 20     # max seconds an HTTP request waits for a segment
HLS_IDLE_TIMEOUT     = 10 * 60  # seconds before unwatched playback artifacts are removed
HLS_MAX_CONCURRENT   = 2      # concurrent playback ffmpeg jobs (downloads win)
HLS_SEGMENT_TIMEOUT  = 120    # max seconds without a completed segment before a batch is killed
HLS_TRANSCODE_PRESET = "ultrafast"  # transcode is a last resort; speed wins
HLS_TRANSCODE_CRF    = 23
HLS_AUDIO_BITRATE    = "128k"
HLS_MAX_RATE         = "5M"   # cap the transcode bitrate so playback never starves the tunnel
HLS_MAX_BUFSIZE      = "10M"
PLAYBACK_DIR_NAME    = ".playback"  # worker-side playback workspace

# Re-encoded HLS renditions never upscale and are capped here so 4K sources
# stay watchable on small CPUs. The original-quality rendition is stream-copied
# and is not subject to this cap. Override with
# STREAMLIFT_PLAYBACK_MAX_HEIGHT (e.g. 2160) if the worker can handle it.
def _playback_max_height() -> int:
    try:
        value = int(os.environ.get("STREAMLIFT_PLAYBACK_MAX_HEIGHT", "") or 0)
    except ValueError:
        value = 0
    return value if value > 0 else 1080

HLS_MAX_HEIGHT = _playback_max_height()


@dataclass
class WorkerConfig:
    worker_id:         str
    auth_token:        str
    api_base_url:      str
    compute_type:      ComputeType
    download_location: DownloadLocation
    pinggy_token:      str = ""
    tunnel_provider:   TunnelProvider = "pinggy"
    # tunnl.gg stable mode: path to SSH key file on the worker's machine (optional)
    tunnlgg_ssh_key_path: str = ""
    # zrok: account token from myzrok.io
    zrok_token:        str = ""
    mega_email:        str = ""
    mega_password:     str = ""
    worker_version:    str = "1.1.0"
    server_port:       int = SERVER_PORT

    @property
    def chunk_size(self) -> int:
        return COMPUTE_CONFIG[self.compute_type]["chunk_size"]
