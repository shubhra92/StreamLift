"""
CLI entry point.

Usage (from PyPI / GitHub):
    streamlift-worker \\
        --worker-id      "uuid" \\
        --auth-token     "token" \\
        --api-url        "https://your-app.com" \\
        --compute-type   "medium" \\
        --location       "mega" \\
        --mega-email     "you@example.com" \\
        --mega-password  "secret"

Or run as a module:
    python -m streamlift_worker ...same flags...
"""

import argparse
import sys

from streamlift_worker.config import WorkerConfig
from streamlift_worker.worker import run


def _parse_args() -> WorkerConfig:
    p = argparse.ArgumentParser(
        prog="streamlift-worker",
        description="StreamLift distributed download worker",
    )

    p.add_argument("--worker-id",      required=True,  help="Worker UUID from StreamLift dashboard")
    p.add_argument("--auth-token",     required=True,  help="Auth token for this worker")
    p.add_argument("--api-url",        required=True,  help="StreamLift backend base URL (e.g. https://app.streamlift.io)")
    p.add_argument("--compute-type",   required=True,  choices=["low", "medium", "high"],
                   help="Resource profile: low | medium | high")
    p.add_argument("--location",       required=True,  choices=["local", "mega"],
                   dest="download_location", help="Where to store downloaded files: local | mega")
    p.add_argument("--mega-email",     default="",     help="Mega account email (required when --location=mega)")
    p.add_argument("--mega-password",  default="",     help="Mega account password (required when --location=mega)")
    p.add_argument("--version",        action="version", version=f"%(prog)s {_get_version()}")

    args = p.parse_args()

    if args.download_location == "mega" and not (args.mega_email and args.mega_password):
        p.error("--mega-email and --mega-password are required when --location=mega")

    return WorkerConfig(
        worker_id=         args.worker_id,
        auth_token=        args.auth_token,
        api_base_url=      args.api_url.rstrip("/"),
        compute_type=      args.compute_type,
        download_location= args.download_location,
        mega_email=        args.mega_email,
        mega_password=     args.mega_password,
    )


def _get_version() -> str:
    try:
        from streamlift_worker import __version__
        return __version__
    except Exception:
        return "unknown"


def main() -> None:
    config = _parse_args()
    run(config)


if __name__ == "__main__":
    main()
