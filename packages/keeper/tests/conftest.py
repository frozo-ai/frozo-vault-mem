"""Shared pytest fixtures."""

from pathlib import Path
import shutil
import tempfile

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
VAULT_TEMPLATE = REPO_ROOT / "vault-template"


@pytest.fixture
def tmp_vault(tmp_path: Path) -> Path:
    """Copy the bundled vault-template to a tmp dir and materialize config.yaml."""
    target = tmp_path / "vault"
    shutil.copytree(str(VAULT_TEMPLATE), str(target))
    cfg_example = target / "_system" / "config.yaml.example"
    cfg = target / "_system" / "config.yaml"
    if cfg_example.exists() and not cfg.exists():
        cfg_example.rename(cfg)
    return target
