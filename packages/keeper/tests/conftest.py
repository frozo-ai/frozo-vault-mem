"""Shared pytest fixtures, including Anthropic SDK mock for offline LLM tests."""

import shutil
from pathlib import Path
from unittest.mock import MagicMock

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


def _msg(text: str, in_tokens: int = 100, out_tokens: int = 20):
    """Construct a stub MagicMock that mimics anthropic.types.Message shape."""
    block = MagicMock()
    block.type = "text"
    block.text = text
    msg = MagicMock()
    msg.content = [block]
    msg.usage = MagicMock(input_tokens=in_tokens, output_tokens=out_tokens)
    msg.stop_reason = "end_turn"
    return msg


@pytest.fixture
def anthropic_mock():
    """Yields (sdk_stub, set_response) where set_response(text) queues
    the next reply from sdk.messages.create. Multiple replies queue up FIFO."""
    sdk = MagicMock()
    queue: list[MagicMock] = []

    def set_response(text: str, *, in_tokens: int = 100, out_tokens: int = 20):
        queue.append(_msg(text, in_tokens, out_tokens))

    def _create(**kwargs):
        if not queue:
            return _msg("default-mock-response")
        return queue.pop(0)

    sdk.messages.create.side_effect = _create
    return sdk, set_response
