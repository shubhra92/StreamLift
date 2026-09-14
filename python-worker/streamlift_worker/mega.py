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
import time
from typing import Any, Callable, Optional

from streamlift_worker import logger
from streamlift_worker.config import WorkerConfig

_mega_client: Optional[Any] = None  # lazy singleton

# download_id → MEGA node id of files this worker uploaded (this process only).
# Powers on-demand share-link creation without re-resolving nodes by name.
_cloud_nodes: dict[str, str] = {}


class UploadCancelled(Exception):
    """Raised by upload progress callbacks when the user cancels a download."""


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


def register_uploaded_node(download_id: str, node_id: str) -> None:
    """Remember the MEGA node id this worker uploaded for *download_id*.

    Stored in-process only — enables on-demand share-link creation for a
    completed download without re-resolving the node by name.
    """
    if node_id:
        _cloud_nodes[download_id] = node_id


def create_node_share_link(
    config: WorkerConfig, download_id: str, file_name: str = ""
) -> Optional[str]:
    """Create a public MEGA share URL for the node uploaded for *download_id*.

    Resolves the node from the in-process registry first (exact match), then
    falls back to looking the file up by name (works after a worker restart,
    when the registry is empty). Returns the share URL or None.
    """
    client = get_mega_client(config)
    node = None
    node_id = _cloud_nodes.get(download_id) or ""
    files = getattr(client, "files", None)
    if node_id and files:
        node = files.get(node_id)
    if node is None and file_name:
        found = client.find(file_name)
        if isinstance(found, tuple) and len(found) > 0 and files:
            node = files.get(found[0])
    if node is None:
        return None
    try:
        link = node.link()
        return link if isinstance(link, str) and link else None
    except Exception as e:
        logger.log("error", f"Could not create share link for {download_id}: {e}")
        return None


def _is_session_error(exc: Exception) -> bool:
    try:
        from streamlift_megapy.errors import MegaSessionError
    except ImportError:
        return False
    return isinstance(exc, MegaSessionError)


class _ProgressReader:
    """Wrap a binary stream and surface upload progress to callbacks.

    *progress_cb* is invoked as ``progress_cb(done_bytes, total_bytes)`` after
    each successful ``read()``. *stall_cb* receives the elapsed seconds of any
    ``read()`` that blocked longer than *stall_warn_seconds*.
    """

    def __init__(
        self,
        stream: Any,
        total: int,
        offset: int = 0,
        progress_cb: Optional[Callable[[int, int], None]] = None,
        stall_cb: Optional[Callable[[float], None]] = None,
        stall_warn_seconds: float = 90.0,
    ) -> None:
        self._stream = stream
        self._total = max(total, 0)
        self._done = offset
        self._progress_cb = progress_cb
        self._stall_cb = stall_cb
        self._stall_warn = stall_warn_seconds

    def read(self, n: int = -1) -> bytes:
        started = time.time()
        chunk = self._stream.read(n)
        elapsed = time.time() - started
        if chunk:
            self._done += len(chunk)
            if self._progress_cb:
                self._progress_cb(self._done, self._total)
        if elapsed >= self._stall_warn and self._stall_cb:
            self._stall_cb(round(elapsed, 1))
        return chunk

    def close(self) -> None:
        try:
            self._stream.close()
        except Exception:
            pass


def stream_to_mega(
    config: WorkerConfig,
    stream: Any,
    file_size: int,
    file_name: str,
    progress_cb: Optional[Callable[[int, int], None]] = None,
    progress_offset: int = 0,
    progress_total: Optional[int] = None,
    stall_cb: Optional[Callable[[float], None]] = None,
    reopen: Optional[Callable[[], Any]] = None,
    retry_session: bool = True,
    dest: Optional[str] = None,
) -> bool:
    """
    Upload binary data from a stream directly to Mega.
    Uses upload_stream() for zero-disk streaming.
    Retries once with a fresh login if the session went stale — the stream is
    reopened via *reopen* on the retry so the file isn't re-read from EOF.

    When *retry_session* is False (non-replayable streams, e.g. a torrent piece
    queue), a stale session is a hard failure: the consumed data can't be
    re-read. Uploads into a folder when *dest* (Mega node id) is given.

    Returns the uploaded node id (truthy string) on success, or "" on failure.
    """
    size_mb = file_size / 1024 / 1024
    logger.log("info", f"Streaming to Mega: {file_name} ({size_mb:.1f} MB)")
    opened: list[Any] = []
    try:
        for attempt in (1, 2):
            if attempt == 1 or reopen is None:
                src = stream
            else:
                src = reopen()
                opened.append(src)
            try:
                client = get_mega_client(config)
                if progress_cb or stall_cb:
                    src = _ProgressReader(
                        src,
                        progress_total or file_size,
                        progress_offset,
                        progress_cb,
                        stall_cb,
                    )
                result = client.upload_stream(src, file_size, file_name, dest=dest)
                logger.log("info", f"Mega upload complete: {file_name}")
                handle = getattr(result, "node_id", None) or ""
                return handle if isinstance(handle, str) else ""
            except UploadCancelled:
                raise
            except Exception as e:
                if attempt == 1 and _is_session_error(e) and retry_session:
                    logger.log("warning", f"Mega session expired mid-upload ({e}); re-logging in and retrying")
                    _expire_session(config)
                    continue
                if attempt == 1 and _is_session_error(e) and not retry_session:
                    logger.log("error", f"Mega session expired during non-replayable stream ({e})")
                    _expire_session(config)
                    return ""
                logger.log("error", f"Mega upload failed: {e}")
                reset_client()
                return ""
    finally:
        for s in opened:
            try:
                s.close()
            except Exception:
                pass
    return ""


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


def upload_file_to_mega(
    config: WorkerConfig,
    file_path: str,
    file_name: str,
    progress_cb: Optional[Callable[[int, int], None]] = None,
    progress_total: Optional[int] = None,
    progress_offset: int = 0,
    stall_cb: Optional[Callable[[float], None]] = None,
) -> str:
    """
    Stream a local file to Mega, then delete it.
    Opens the file as a stream — avoids loading it all into memory.
    Returns the uploaded node id (truthy string) on success, or "" on failure.
    """
    try:
        file_size = os.path.getsize(file_path)

        def _open_stream() -> Any:
            return open(file_path, "rb")

        with open(file_path, "rb") as f:
            handle = stream_to_mega(
                config,
                f,
                file_size,
                file_name,
                progress_cb=progress_cb,
                progress_total=progress_total,
                progress_offset=progress_offset,
                stall_cb=stall_cb,
                reopen=_open_stream,
            )
        if handle:
            try:
                os.remove(file_path)
                logger.log("info", f"Local file deleted after upload: {file_path}")
            except Exception as e:
                logger.log("warning", f"Could not delete local file: {e}")
        return handle or ""
    except UploadCancelled:
        raise
    except Exception as e:
        logger.log("error", f"File upload failed: {e}")
        reset_client()
        return ""


def upload_files_to_mega_folder(
    config: WorkerConfig,
    files: list[str],
    folder_name: str,
    progress_cb: Optional[Callable[[int, int], None]] = None,
    progress_total: Optional[int] = None,
    stall_cb: Optional[Callable[[float], None]] = None,
) -> bool:
    """
    Upload multiple local files into a named Mega folder.
    Creates the folder first if it doesn't exist.
    Reports cumulative progress across all files when *progress_cb* is given.
    """
    if not files:
        return True

    try:
        client = get_mega_client(config)
        folder = client.create_folder(folder_name)
        logger.log("info", f"Mega folder ready: {folder_name} ({folder.node_id})")
    except Exception as e:
        logger.log("error", f"Failed to create Mega folder: {e}")
        return False

    total_size = progress_total if progress_total else 0
    if not total_size:
        for fp in files:
            try:
                total_size += os.path.getsize(fp)
            except OSError:
                pass

    offset = 0
    for i, fp in enumerate(files, 1):
        fname = os.path.basename(fp)
        try:
            fsize = os.path.getsize(fp)
        except OSError as e:
            logger.log("error", f"Missing file for upload {fname}: {e}")
            return False
        logger.log("info", f"Uploading {i}/{len(files)}: {fname} ({fsize/1024/1024:.2f} MB)")

        for attempt in (1, 2):
            src = None
            try:
                client = get_mega_client(config)
                src = open(fp, "rb")
                if progress_cb or stall_cb:
                    src = _ProgressReader(src, total_size, offset, progress_cb, stall_cb)
                client.upload_stream(src, fsize, fname, dest=folder.node_id)
                logger.log("info", f"Uploaded: {fname}")
                try:
                    os.remove(fp)
                except Exception:
                    pass
                break
            except UploadCancelled:
                raise
            except Exception as e:
                if attempt == 1 and _is_session_error(e):
                    logger.log("warning", f"Mega session expired during folder upload ({e}); re-logging in and retrying")
                    _expire_session(config)
                    continue
                logger.log("error", f"Failed to upload {fname}: {e}")
                return False
            finally:
                if src is not None:
                    try:
                        src.close()
                    except Exception:
                        pass

        offset += fsize

    logger.log("info", f"All {len(files)} files uploaded to Mega folder: {folder_name}")
    return True
