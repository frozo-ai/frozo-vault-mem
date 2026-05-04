import tempfile
from pathlib import Path

import pytest

from vault_mem_keeper.config import load_keeper_config


def test_loads_defaults_when_keeper_section_missing():
    with tempfile.TemporaryDirectory() as d:
        sysd = Path(d, "_system")
        sysd.mkdir()
        (sysd / "config.yaml").write_text(
            "vault_version: 0.1\n"
            "schema_version: 0.1\n"
            "default_agent: human\n"
            "inbox_routing: always\n"
            "fts:\n"
            "  index_path: _system/index.sqlite\n"
            "  rebuild_on_startup: false\n"
            "audit:\n"
            "  log_path: _system/audit.log\n"
        )
        cfg = load_keeper_config(d)
        # Even without a keeper: section, defaults are returned with all enabled True
        assert cfg.triage.enabled is True
        assert cfg.triage.min_age_minutes == 1440
        assert cfg.link.top_k == 5
        assert cfg.decay.rates["observation"] == 30
        assert cfg.archive.archive_below_confidence == 0.3


def test_loads_explicit_keeper_section():
    with tempfile.TemporaryDirectory() as d:
        sysd = Path(d, "_system")
        sysd.mkdir()
        (sysd / "config.yaml").write_text(
            "vault_version: 0.1\n"
            "schema_version: 0.1\n"
            "default_agent: human\n"
            "inbox_routing: always\n"
            "fts:\n"
            "  index_path: _system/index.sqlite\n"
            "  rebuild_on_startup: false\n"
            "audit:\n"
            "  log_path: _system/audit.log\n"
            "keeper:\n"
            "  triage:\n"
            "    enabled: false\n"
            "    min_age_minutes: 60\n"
            "  link:\n"
            "    top_k: 10\n"
        )
        cfg = load_keeper_config(d)
        assert cfg.triage.enabled is False
        assert cfg.triage.min_age_minutes == 60
        assert cfg.link.top_k == 10
        # untouched fields stay at defaults
        assert cfg.archive.enabled is True


def test_raises_when_config_file_missing():
    with tempfile.TemporaryDirectory() as d, pytest.raises(FileNotFoundError):
        load_keeper_config(d)


def test_loads_default_phase5_config_when_section_missing():
    with tempfile.TemporaryDirectory() as d:
        sysd = Path(d, "_system")
        sysd.mkdir()
        (sysd / "config.yaml").write_text(
            "vault_version: 0.1\n"
            "schema_version: 0.1\n"
            "default_agent: human\n"
            "inbox_routing: always\n"
            "fts:\n"
            "  index_path: _system/index.sqlite\n"
            "  rebuild_on_startup: false\n"
            "audit:\n"
            "  log_path: _system/audit.log\n"
        )
        cfg = load_keeper_config(d)
        assert cfg.contradict.enabled is True
        assert cfg.contradict.top_k == 5
        assert cfg.summarize.daily.min_new_memories == 5
        assert cfg.budget.monthly_usd_cap == 5.00
        assert cfg.state_path == "_system/state.json"


def test_loads_custom_phase5_overrides():
    with tempfile.TemporaryDirectory() as d:
        sysd = Path(d, "_system")
        sysd.mkdir()
        (sysd / "config.yaml").write_text(
            "vault_version: 0.1\n"
            "schema_version: 0.1\n"
            "default_agent: human\n"
            "inbox_routing: always\n"
            "fts:\n"
            "  index_path: _system/index.sqlite\n"
            "  rebuild_on_startup: false\n"
            "audit:\n"
            "  log_path: _system/audit.log\n"
            "keeper:\n"
            "  budget:\n"
            "    monthly_usd_cap: 20.0\n"
            "  summarize:\n"
            "    daily:\n"
            "      min_new_memories: 10\n"
        )
        cfg = load_keeper_config(d)
        assert cfg.budget.monthly_usd_cap == 20.0
        assert cfg.summarize.daily.min_new_memories == 10
        # Untouched defaults remain
        assert cfg.contradict.top_k == 5
