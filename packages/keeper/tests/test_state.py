import json
import tempfile
from pathlib import Path

import pytest

from vault_mem_keeper.state import read_state, write_state


def test_read_state_returns_defaults_when_file_missing():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "state.json"))
        s = read_state(path)
        assert s == {"last_contradict_at": None, "summaries": {}}


def test_round_trip():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "state.json"))
        write_state(path, {
            "last_contradict_at": "2026-05-01T00:00:00Z",
            "summaries": {"myapp": {"daily": "2026-05-01T00:00:00Z"}},
        })
        s = read_state(path)
        assert s["last_contradict_at"] == "2026-05-01T00:00:00Z"
        assert s["summaries"]["myapp"]["daily"] == "2026-05-01T00:00:00Z"


def test_partial_state_merges_with_defaults():
    """If the on-disk file has only some keys, missing ones get defaults."""
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "state.json"))
        Path(path).write_text(json.dumps({"last_contradict_at": "2026-05-01T00:00:00Z"}))
        s = read_state(path)
        assert s["last_contradict_at"] == "2026-05-01T00:00:00Z"
        assert s["summaries"] == {}


def test_corrupt_file_returns_defaults_and_warns(caplog):
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "state.json"))
        Path(path).write_text("not valid json {{{")
        s = read_state(path)
        assert s == {"last_contradict_at": None, "summaries": {}}
