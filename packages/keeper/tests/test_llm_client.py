import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from vault_mem_keeper.llm.budget import BudgetTracker
from vault_mem_keeper.llm.client import AnthropicClient, BudgetExceeded

PRICE_TABLE_HAIKU_INPUT_PER_MTOK = 0.80   # USD per million input tokens
PRICE_TABLE_HAIKU_OUTPUT_PER_MTOK = 4.00
PRICE_TABLE_SONNET_INPUT_PER_MTOK = 3.00
PRICE_TABLE_SONNET_OUTPUT_PER_MTOK = 15.00


def _fake_response(text: str, in_tokens: int = 100, out_tokens: int = 20):
    msg = MagicMock()
    msg.content = [MagicMock(text=text, type="text")]
    msg.usage = MagicMock(input_tokens=in_tokens, output_tokens=out_tokens)
    msg.stop_reason = "end_turn"
    return msg


def test_haiku_call_records_cost_and_returns_text():
    with tempfile.TemporaryDirectory() as d:
        budget_path = str(Path(d, "budget.jsonl"))
        bt = BudgetTracker(budget_path, monthly_cap_usd=10.0)
        sdk = MagicMock()
        sdk.messages.create.return_value = _fake_response("yes", in_tokens=200, out_tokens=2)
        client = AnthropicClient(
            sdk=sdk, budget=bt, haiku_model="claude-haiku-4-5",
            sonnet_model="claude-sonnet-4-7", api_key="test",
        )
        resp = client.haiku("Are these the same?", op="contradict_prefilter", run_id="r1")
        assert resp.text == "yes"
        assert resp.cost_usd > 0
        # SDK called with haiku model name
        sdk.messages.create.assert_called_once()
        kwargs = sdk.messages.create.call_args.kwargs
        assert kwargs["model"] == "claude-haiku-4-5"


def test_sonnet_call_uses_sonnet_model():
    with tempfile.TemporaryDirectory() as d:
        budget_path = str(Path(d, "budget.jsonl"))
        bt = BudgetTracker(budget_path, monthly_cap_usd=10.0)
        sdk = MagicMock()
        sdk.messages.create.return_value = _fake_response("a thoughtful answer")
        client = AnthropicClient(
            sdk=sdk, budget=bt, haiku_model="claude-haiku-4-5",
            sonnet_model="claude-sonnet-4-7", api_key="test",
        )
        client.sonnet("Judge this contradiction", op="contradict_judge", run_id="r1")
        kwargs = sdk.messages.create.call_args.kwargs
        assert kwargs["model"] == "claude-sonnet-4-7"


def test_budget_exceeded_returns_sentinel_without_calling_sdk():
    with tempfile.TemporaryDirectory() as d:
        budget_path = str(Path(d, "budget.jsonl"))
        # Pre-populate over-cap spending
        from datetime import UTC, datetime
        ts = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        Path(budget_path).write_text(
            f'{{"ts":"{ts}","v":1,"model":"x","input_tokens":1,"output_tokens":1,"cost_usd":99.0,"op":"x","run_id":"x"}}\n'
        )
        bt = BudgetTracker(budget_path, monthly_cap_usd=1.0)
        sdk = MagicMock()
        client = AnthropicClient(
            sdk=sdk, budget=bt, haiku_model="claude-haiku-4-5",
            sonnet_model="claude-sonnet-4-7", api_key="test",
        )
        with pytest.raises(BudgetExceeded):
            client.haiku("hi", op="x", run_id="r1")
        sdk.messages.create.assert_not_called()


def test_retry_on_429_then_success():
    """SDK errors with status 429 should be retried up to 3 times."""
    from anthropic import APIStatusError

    with tempfile.TemporaryDirectory() as d:
        bt = BudgetTracker(str(Path(d, "budget.jsonl")), monthly_cap_usd=10.0)
        sdk = MagicMock()
        # First call: 429 error. Second call: success.
        err = APIStatusError(message="rate limited", response=MagicMock(status_code=429), body={})
        sdk.messages.create.side_effect = [err, _fake_response("ok")]
        client = AnthropicClient(
            sdk=sdk, budget=bt, haiku_model="claude-haiku-4-5",
            sonnet_model="claude-sonnet-4-7", api_key="test",
            retry_max=3, retry_base_seconds=0.001,
        )
        resp = client.haiku("hi", op="x", run_id="r1")
        assert resp.text == "ok"
        assert sdk.messages.create.call_count == 2


def test_has_key_false_without_env():
    with tempfile.TemporaryDirectory() as d:
        bt = BudgetTracker(str(Path(d, "budget.jsonl")), monthly_cap_usd=10.0)
        client = AnthropicClient(
            sdk=None, budget=bt, haiku_model="x", sonnet_model="y", api_key=None,
        )
        assert not client.has_key()
