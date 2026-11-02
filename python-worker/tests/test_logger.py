"""Unit tests for streamlift_worker.logger console gating."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from streamlift_worker import logger  # noqa: E402


def test_log_records_entry_when_console_disabled(capsys):
    logger.set_console_enabled(False)
    try:
        logger.log("info", "quiet entry")
        assert capsys.readouterr().out == ""
        assert logger.peek_recent(1)[-1]["message"] == "quiet entry"
    finally:
        logger.set_console_enabled(True)


def test_log_prints_when_console_enabled(capsys):
    logger.set_console_enabled(True)
    logger.log("info", "loud entry")
    assert "loud entry" in capsys.readouterr().out
