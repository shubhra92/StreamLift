"""Unit tests for streamlift_worker.file_info (mirrors Express fileInfo controller)."""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from unittest.mock import MagicMock

from streamlift_worker.file_info import (  # noqa: E402
    _ext_from_mime,
    _filename_from_url,
    _parse_content_disposition,
    fetch_http_file_info,
)


def test_parse_content_disposition_utf8():
    assert _parse_content_disposition("attachment; filename*=UTF-8''hello%20.txt") == "hello .txt"


def test_parse_content_disposition_quoted():
    assert _parse_content_disposition('attachment; filename="report.pdf"') == "report.pdf"


def test_parse_content_disposition_bare():
    assert _parse_content_disposition("attachment; filename=data.csv") == "data.csv"


def test_parse_content_disposition_none():
    assert _parse_content_disposition(None) is None
    assert _parse_content_disposition("") is None


def test_filename_from_url():
    assert _filename_from_url("https://example.com/path/to/file.txt") == "file.txt"
    assert _filename_from_url("https://example.com/path") == "path"
    assert _filename_from_url("https://example.com/") is None
    assert _filename_from_url("not a url") is None


def test_ext_from_mime():
    assert _ext_from_mime("video/mp4") == "mp4"
    assert _ext_from_mime("application/octet-stream") == "bin"
    assert _ext_from_mime("text/plain") == "plain"
    assert _ext_from_mime(None) is None


def _mock_response(
    ok=True,
    status_code=200,
    content_type="video/mp4",
    content_length="12345",
    content_disposition='attachment; filename="vid.mkv"',
    content_range=None,
):
    r = MagicMock()
    r.ok = ok
    r.status_code = status_code
    r.headers = {
        "content-type": content_type,
        "content-length": content_length,
        "content-disposition": content_disposition,
    }
    if content_range:
        r.headers["content-range"] = content_range
    r.close = MagicMock()
    return r


class _FakeTimeout(Exception):
    pass


def _patch_requests(monkeypatch, head_resp=None, get_resp=None):
    import requests as _requests
    if head_resp is not None:
        monkeypatch.setattr(_requests, "head", lambda *a, **kw: head_resp)
    if get_resp is not None:
        monkeypatch.setattr(_requests, "get", lambda *a, **kw: get_resp)
    monkeypatch.setattr(_requests, "Timeout", _FakeTimeout)
    monkeypatch.setattr(_requests, "RequestException", type("_ReqExc", (Exception,), {}))


def test_fetch_http_file_info_head_success(monkeypatch):
    resp = _mock_response(ok=True, content_type="image/png", content_length="999", content_disposition=None)
    _patch_requests(monkeypatch, head_resp=resp)
    info = fetch_http_file_info("https://example.com/photo.png")
    assert info == {
        "fileName": "photo.png",
        "fileSize": 999,
        "fileType": "image/png",
        "fileExtension": "png",
    }


def test_fetch_http_file_info_fallback_to_range_get(monkeypatch):
    head = _mock_response(ok=False, status_code=405)
    get = _mock_response(ok=False, status_code=206, content_type="application/pdf", content_length="42", content_disposition='inline; filename="doc.pdf"')
    _patch_requests(monkeypatch, head_resp=head, get_resp=get)
    info = fetch_http_file_info("https://example.com/doc.pdf?x=1")
    assert info["fileName"] == "doc.pdf"
    assert info["fileSize"] == 42
    assert info["fileType"] == "application/pdf"
    assert info["fileExtension"] == "pdf"


def test_fetch_http_file_info_content_range_fallback(monkeypatch):
    resp = _mock_response(
        ok=True,
        content_type="application/octet-stream",
        content_length=None,
        content_disposition=None,
        content_range="bytes 0-0/5678",
    )
    _patch_requests(monkeypatch, head_resp=resp)
    info = fetch_http_file_info("https://example.com/big.bin")
    assert info["fileSize"] == 5678
    assert info["fileName"] == "big.bin"


def test_fetch_http_file_info_timeout(monkeypatch):
    import requests as _requests

    def boom(*a, **kw):
        raise _FakeTimeout("timed out")

    monkeypatch.setattr(_requests, "head", boom)
    monkeypatch.setattr(_requests, "Timeout", _FakeTimeout)
    with pytest.raises(TimeoutError):
        fetch_http_file_info("https://example.com/slow.bin")
