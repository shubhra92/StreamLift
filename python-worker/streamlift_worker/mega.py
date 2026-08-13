"""
Mega upload helpers.
Uses the patched mega.py fork that exposes upload_stream().
Falls back to a temp-file approach if the older API is installed.
"""

import io
import os
import tempfile
from typing import Any, Optional

from streamlift_worker import logger
from streamlift_worker.config import WorkerConfig

_mega_client: Optional[Any] = None  # lazy singleton


def get_mega_client(config: WorkerConfig) -> Any:
    """
    Return a logged-in Mega client (lazy singleton).
    1. Try restoring a saved session from the backend.
    2. Fall back to a fresh credential login.
    3. Persist the new session so the next startup is faster.
    """
    global _mega_client
    if _mega_client is not None:
        return _mega_client

    if not config.mega_email or not config.mega_password:
        raise RuntimeError("Mega credentials are not configured for this worker")

    try:
        from mega import Mega  # type: ignore[import]
    except ImportError:
        raise RuntimeError(
            "mega.py not installed.\n"
            "Run: pip install git+https://github.com/shubhra92/megapy.git"
        )

    # ── Try session restore first ─────────────────────────────────────────
    from streamlift_worker import api
    saved_sid = api.load_mega_session(config)
    if saved_sid:
        try:
            logger.log("info", "Restoring Mega session from backend...")
            client = Mega().login(session=saved_sid)
            _mega_client = client
            logger.log("info", "Mega session restored successfully")
            return _mega_client
        except Exception as e:
            logger.log("warning", f"Session restore failed ({e}), falling back to fresh login")
            _mega_client = None

    # ── Fresh login ───────────────────────────────────────────────────────
    logger.log("info", f"Logging in to Mega as {config.mega_email}...")
    client = Mega().login(config.mega_email, config.mega_password)
    _mega_client = client
    logger.log("info", "Mega login successful")

    try:
        sid = client.sid
        if sid:
            api.save_mega_session(config, sid)
    except Exception as e:
        logger.log("warning", f"Could not save session SID: {e}")

    return _mega_client


def reset_client() -> None:
    """Force a fresh login on the next call (used after upload errors)."""
    global _mega_client
    _mega_client = None


def stream_to_mega(config: WorkerConfig, stream: Any, file_size: int, file_name: str) -> bool:
    """
    Upload binary data from a stream directly to Mega.
    Preferred: upload_stream(stream, size, name) — zero disk write.
    Fallback:  buffer to a temp file (old mega.py without upload_stream).
    """
    size_mb = file_size / 1024 / 1024
    logger.log("info", f"Streaming to Mega: {file_name} ({size_mb:.1f} MB)")
    try:
        client = get_mega_client(config)

        if hasattr(client, "upload_stream"):
            client.upload_stream(stream, file_size, file_name)
        else:
            logger.log(
                "warning",
                "upload_stream not available — buffering to temp file. "
                "Upgrade: pip install --force-reinstall git+https://github.com/shubhra92/megapy.git"
            )
            data = stream.read(-1)
            with tempfile.NamedTemporaryFile(delete=False, suffix="_" + file_name) as tmp:
                tmp.write(data)
                tmp_path = tmp.name
            try:
                client.upload(tmp_path)
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)

        logger.log("info", f"Mega upload complete: {file_name}")
        return True

    except Exception as e:
        logger.log("error", f"Mega upload failed: {e}")
        reset_client()
        return False


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
        client.create_folder(folder_name)
        folder_node = client.find(folder_name)
        if folder_node is None:
            raise RuntimeError(f"Folder '{folder_name}' not found after creation")
        folder_handle = folder_node[0]
        logger.log("info", f"Mega folder ready: {folder_name}")
    except Exception as e:
        logger.log("error", f"Failed to create Mega folder: {e}")
        return False

    for i, fp in enumerate(files, 1):
        fname = os.path.basename(fp)
        fsize = os.path.getsize(fp)
        logger.log("info", f"Uploading {i}/{len(files)}: {fname} ({fsize/1024/1024:.2f} MB)")
        try:
            client = get_mega_client(config)
            with open(fp, "rb") as f:
                if hasattr(client, "upload_stream"):
                    client.upload_stream(f, fsize, fname, dest=folder_handle)
                else:
                    client.upload(fp, dest=folder_handle)
            logger.log("info", f"Uploaded: {fname}")
            try:
                os.remove(fp)
            except Exception:
                pass
        except Exception as e:
            logger.log("error", f"Failed to upload {fname}: {e}")
            return False

    logger.log("info", f"All {len(files)} files uploaded to Mega folder: {folder_name}")
    return True
