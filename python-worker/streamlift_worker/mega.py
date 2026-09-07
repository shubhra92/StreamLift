"""
Mega upload helpers using the custom streamlift-megapy package.
Handles login, session persistence, and zero-disk streaming uploads.

Two modes are supported:
  * Legacy — credentials (--mega-email/--mega-password) stored/generated in the
    bootstrap script; sessions are restored when possible and re-created from
    credentials when stale.
  * Session-only — the dashboard logs into Mega in the browser (the password
    never leaves the client) and stores a fresh JS session on the backend. The
    worker loads it, validates it, and signals a re-link request if it goes
    stale, instead of ever holding credentials.
"""

import os
from typing import Any, Optional

from streamlift_worker import logger
from streamlift_worker.config import WorkerConfig

_mega_client: Optional[Any] = None  # lazy singleton


def get_mega_client(config: WorkerConfig) -> Any:
    """
    Return a logged-in Mega client (lazy singleton).

    * Legacy workers (email + password in the bootstrap script):
      1. Try restoring a saved session from the backend, validating it is alive.
      2. Fall back to a fresh credential login and persist the new session.
    * Session-only workers (no credentials): load the browser-minted session
      from the backend. If it is stale, signal a re-link and raise.
    """
    global _mega_client
    if _mega_client is not None:
        return _mega_client

    from streamlift_worker import api

    if not (config.mega_email and config.mega_password):
        return _session_only_login(config)

    try:
        from streamlift_megapy import Mega
        from streamlift_megapy.errors import MegaSessionError
    except ImportError:
        raise RuntimeError("streamlift-megapy package not installed.\nRun: pip install -e ../streamlift-megapy")

    # ── Try session restore first ─────────────────────────────────────────
    saved = api.load_mega_session(config)
    if saved:
        try:
            logger.log("info", "Restoring Mega session from backend...")
            client = Mega().login(session=saved)
            # A restored session is only trusted if it is still valid
            # server-side. MEGA can revoke a session at any time (e.g. the
            # user logged out on another device), so probe it now.
            client.get_quota()
            _mega_client = client
            logger.log("info", "Mega session restored successfully")
            return _mega_client
        except MegaSessionError as e:
            logger.log("warning", f"Restored Mega session is invalid ({e}); discarding it")
            _mega_client = None
            try:
                api.delete_mega_session(config)
            except Exception:
                pass
        except Exception as e:
            logger.log("warning", f"Session restore failed ({e}), falling back to fresh login")
            _mega_client = None

    # ── Fresh login ───────────────────────────────────────────────────────
    return _fresh_login(config)


def _session_only_login(config: WorkerConfig) -> Any:
    """Login path for workers that have no credentials — only a stored session."""
    global _mega_client
    try:
        from streamlift_megapy import Mega
        from streamlift_megapy.errors import MegaSessionError
    except ImportError:
        raise RuntimeError("streamlift-megapy package not installed.\nRun: pip install -e ../streamlift-megapy")

    from streamlift_worker import api

    saved = api.load_mega_session(config)
    if not saved:
        api.report_mega_needs_relink(config, "No Mega session stored for this worker")
        raise RuntimeError(
            "No Mega session found for this worker. Re-link your Mega account "
            "in the StreamLift dashboard, then restart the worker."
        )

    logger.log("info", "Restoring Mega session from backend...")
    try:
        client = Mega().login(session=saved)
        client.get_quota()
        _mega_client = client
        logger.log("info", "Mega session restored successfully")
        return _mega_client
    except MegaSessionError as e:
        logger.log("warning", f"Mega session is invalid/expired ({e}); clearing it")
        _expire_session(config)
        raise RuntimeError(
            "Mega session expired or was revoked. Re-link your Mega account "
            "in the StreamLift dashboard, then restart the worker."
        ) from e
    except Exception as e:
        logger.log("warning", f"Mega session restore failed ({e})")
        _expire_session(config)
        raise RuntimeError(f"Mega session could not be restored: {e}") from e


def _fresh_login(config: WorkerConfig) -> Any:
    """Perform a credential login (bypassing any saved session) and persist it."""
    global _mega_client
    from streamlift_megapy import Mega

    logger.log("info", f"Logging in to Mega as {config.mega_email}...")
    client = Mega().login(config.mega_email, config.mega_password)
    _mega_client = client
    logger.log("info", "Mega login successful")

    try:
        from streamlift_worker import api

        session_json = client.to_json()
        api.save_mega_session(config, session_json)
    except Exception as e:
        logger.log("warning", f"Could not save session: {e}")

    return _mega_client


def reset_client() -> None:
    """Force a fresh login on the next call (used after upload errors)."""
    global _mega_client
    _mega_client = None


def _is_session_error(exc: Exception) -> bool:
    try:
        from streamlift_megapy.errors import MegaSessionError
    except ImportError:
        return False
    return isinstance(exc, MegaSessionError)


def stream_to_mega(config: WorkerConfig, stream: Any, file_size: int, file_name: str) -> bool:
    """
    Upload binary data from a stream directly to Mega.
    Uses upload_stream() for zero-disk streaming.
    Retries once with a fresh credential login if the session went stale.
    """
    size_mb = file_size / 1024 / 1024
    logger.log("info", f"Streaming to Mega: {file_name} ({size_mb:.1f} MB)")
    for attempt in (1, 2):
        try:
            client = get_mega_client(config)
            client.upload_stream(stream, file_size, file_name)
            logger.log("info", f"Mega upload complete: {file_name}")
            return True
        except Exception as e:
            if attempt == 1 and _is_session_error(e):
                logger.log("warning", f"Mega session expired mid-upload ({e}); re-logging in and retrying")
                _expire_session(config)
                continue
            logger.log("error", f"Mega upload failed: {e}")
            reset_client()
            return False
    return False


def _expire_session(config: WorkerConfig) -> None:
    """Drop the cached client, purge any stale session, and — for session-only
    workers — signal the dashboard that the account needs re-linking."""
    reset_client()
    try:
        from streamlift_worker import api

        api.delete_mega_session(config)
        if not (config.mega_email and config.mega_password):
            api.report_mega_needs_relink(config, "Mega session expired or was revoked")
    except Exception as e:
        logger.log("warning", f"Could not clear stale Mega session: {e}")


def upload_file_to_mega(config: WorkerConfig, file_path: str, file_name: str) -> bool:
    """
    Stream a local file to Mega, then delete it.
    Opens the file as a stream — avoids loading it all into memory.
    """
    try:
        file_size = os.path.getsize(file_path)
        with open(file_path, "rb") as f:
            ok = stream_to_mega(config, f, file_size, file_name)
        if ok:
            try:
                os.remove(file_path)
                logger.log("info", f"Local file deleted after upload: {file_path}")
            except Exception as e:
                logger.log("warning", f"Could not delete local file: {e}")
        return ok
    except Exception as e:
        logger.log("error", f"File upload failed: {e}")
        reset_client()
        return False


def upload_files_to_mega_folder(
    config: WorkerConfig,
    files: list[str],
    folder_name: str,
) -> bool:
    """
    Upload multiple local files into a named Mega folder.
    Creates the folder first if it doesn't exist.
    """
    try:
        client = get_mega_client(config)
        folder = client.create_folder(folder_name)
        logger.log("info", f"Mega folder ready: {folder_name}")
    except Exception as e:
        logger.log("error", f"Failed to create Mega folder: {e}")
        return False

    for i, fp in enumerate(files, 1):
        fname = os.path.basename(fp)
        fsize = os.path.getsize(fp)
        logger.log("info", f"Uploading {i}/{len(files)}: {fname} ({fsize/1024/1024:.2f} MB)")
        for attempt in (1, 2):
            try:
                client = get_mega_client(config)
                with open(fp, "rb") as f:
                    client.upload_stream(f, fsize, fname, dest=folder.node_id)
                logger.log("info", f"Uploaded: {fname}")
                try:
                    os.remove(fp)
                except Exception:
                    pass
                break
            except Exception as e:
                if attempt == 1 and _is_session_error(e):
                    logger.log("warning", f"Mega session expired during folder upload ({e}); re-logging in and retrying")
                    _expire_session(config)
                    continue
                logger.log("error", f"Failed to upload {fname}: {e}")
                return False
        else:
            continue

    logger.log("info", f"All {len(files)} files uploaded to Mega folder: {folder_name}")
    return True
