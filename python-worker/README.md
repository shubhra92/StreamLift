# streamlift-worker

Distributed download worker for [StreamLift](https://github.com/shubhra92/StreamLift).  
Designed to run in **Google Colab** — paste the one-liner from the dashboard and go.

## What it does

- Registers itself with the StreamLift backend
- Polls for download tasks (HTTP URLs or magnet links)
- Downloads files and streams them directly to **Mega** (zero local disk) or saves them **locally**
- Reports live progress back to the backend
- Sends heartbeats with CPU / RAM / network metrics

## Install & run (Colab cell)

The StreamLift UI generates this for you with all credentials pre-filled:

```python
!pip install -q requests psutil
!pip install -q git+https://github.com/shubhra92/megapy.git
!pip install -q git+https://github.com/shubhra92/streamlift-worker.git

!streamlift-worker \
  --worker-id     "your-worker-uuid" \
  --auth-token    "your-auth-token" \
  --api-url       "https://your-app.com" \
  --compute-type  "medium" \
  --location      "mega" \
  --mega-email    "you@example.com" \
  --mega-password "yourpassword"
```

## CLI flags

| Flag | Required | Description |
|------|----------|-------------|
| `--worker-id` | ✅ | Worker UUID from the StreamLift dashboard |
| `--auth-token` | ✅ | Auth token for this worker |
| `--api-url` | ✅ | StreamLift backend base URL |
| `--compute-type` | ✅ | Resource profile: `low` \| `medium` \| `high` |
| `--location` | ✅ | Where to store files: `local` \| `mega` |
| `--mega-email` | ⚠️ | Required when `--location=mega` |
| `--mega-password` | ⚠️ | Required when `--location=mega` |

## Package structure

```
streamlift_worker/
├── __init__.py       # version
├── __main__.py       # CLI entry point & arg parsing
├── config.py         # WorkerConfig dataclass
├── worker.py         # main loop, registration, heartbeat thread
├── downloader.py     # HTTP + torrent download handlers
├── mega.py           # Mega upload helpers (stream & file)
├── api.py            # all HTTP calls to the backend
├── metrics.py        # CPU / RAM / network metrics
└── logger.py         # in-process log queue
```
