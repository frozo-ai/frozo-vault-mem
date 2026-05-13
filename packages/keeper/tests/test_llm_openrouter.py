"""Unit tests for the OpenRouter adapter (no live HTTP)."""

import json
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest

from vault_mem_keeper.llm.budget import BudgetTracker
from vault_mem_keeper.llm.client import BudgetExceeded
from vault_mem_keeper.llm.openrouter import OpenRouterClient


def _http_mock(*responses):
    """Build a MagicMock httpx.Client whose .post() returns the queued responses."""
    queue = list(responses)
    http = MagicMock(spec=httpx.Client)

    def _post(*_args, **_kwargs):
        if not queue:
            raise AssertionError("ran out of mocked responses")
        return queue.pop(0)
    http.post.side_effect = _post
    return http


def _ok_response(text: str = "ok", *, prompt_tokens: int = 12,
                 completion_tokens: int = 5, cost: float | None = 0.00012,
                 finish_reason: str = "stop") -> MagicMock:
    body = {
        "choices": [{
            "message": {"role": "assistant", "content": text},
            "finish_reason": finish_reason,
        }],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }
    if cost is not None:
        body["usage"]["cost"] = cost
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = 200
    resp.json.return_value = body
    resp.raise_for_status = MagicMock()
    return resp


def _transient_response(status: int) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.request = MagicMock(spec=httpx.Request)
    resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        f"{status}", request=resp.request, response=resp,
    )
    return resp


def test_has_key_true_when_set(tmp_path):
    budget_log = str(tmp_path / "budget.jsonl")
    client = OpenRouterClient(
        api_key="or-xxx",
        budget=BudgetTracker(budget_log, 5.0),
        haiku_model="claude-haiku-4-5",
        sonnet_model="claude-sonnet-4-5",
        http=_http_mock(),
    )
    assert client.has_key() is True


def test_has_key_false_when_unset(tmp_path):
    budget_log = str(tmp_path / "budget.jsonl")
    client = OpenRouterClient(
        api_key=None,
        budget=BudgetTracker(budget_log, 5.0),
        haiku_model="claude-haiku-4-5",
        sonnet_model="claude-sonnet-4-5",
        http=_http_mock(),
    )
    assert client.has_key() is False


def test_haiku_round_trip_parses_text_tokens_and_cost(tmp_path):
    budget_log = str(tmp_path / "budget.jsonl")
    http = _http_mock(_ok_response("yes", prompt_tokens=42, completion_tokens=2, cost=0.00009))
    client = OpenRouterClient(
        api_key="or-xxx",
        budget=BudgetTracker(budget_log, 5.0),
        haiku_model="claude-haiku-4-5",
        sonnet_model="claude-sonnet-4-5",
        http=http,
    )
    r = client.haiku("hello", op="contradict_prefilter", run_id="t")
    assert r.text == "yes"
    assert r.input_tokens == 42
    assert r.output_tokens == 2
    assert r.cost_usd == pytest.approx(0.00009)
    assert r.model == "anthropic/claude-haiku-4-5"

    # Budget log was written
    lines = Path(budget_log).read_text().strip().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["model"] == "anthropic/claude-haiku-4-5"
    assert rec["op"] == "contradict_prefilter"
    assert rec["input_tokens"] == 42
    assert rec["output_tokens"] == 2

    # Payload sent had the prefixed model
    sent = http.post.call_args
    assert sent.args[0] == "/chat/completions"
    payload = sent.kwargs["json"]
    assert payload["model"] == "anthropic/claude-haiku-4-5"
    assert payload["messages"] == [{"role": "user", "content": "hello"}]
    assert payload["max_tokens"] == 256


def test_already_prefixed_model_name_passes_through(tmp_path):
    http = _http_mock(_ok_response())
    client = OpenRouterClient(
        api_key="or-xxx",
        budget=BudgetTracker(str(tmp_path / "b.jsonl"), 5.0),
        haiku_model="anthropic/claude-haiku-4.5",  # already vendor-prefixed
        sonnet_model="anthropic/claude-sonnet-4.5",
        http=http,
    )
    client.haiku("x", op="op", run_id="rid")
    payload = http.post.call_args.kwargs["json"]
    assert payload["model"] == "anthropic/claude-haiku-4.5"  # not double-prefixed


def test_sonnet_uses_sonnet_model(tmp_path):
    http = _http_mock(_ok_response())
    client = OpenRouterClient(
        api_key="or-xxx",
        budget=BudgetTracker(str(tmp_path / "b.jsonl"), 5.0),
        haiku_model="claude-haiku-4-5",
        sonnet_model="claude-sonnet-4-5",
        http=http,
    )
    client.sonnet("q", op="contradict_judge", run_id="rid")
    payload = http.post.call_args.kwargs["json"]
    assert payload["model"] == "anthropic/claude-sonnet-4-5"
    assert payload["max_tokens"] == 1500


def test_falls_back_to_price_table_when_cost_missing(tmp_path):
    """If OpenRouter omits `usage.cost`, fall back to our internal _PRICES."""
    http = _http_mock(_ok_response(
        prompt_tokens=1_000_000, completion_tokens=0, cost=None,
    ))
    client = OpenRouterClient(
        api_key="or-xxx",
        budget=BudgetTracker(str(tmp_path / "b.jsonl"), 5.0),
        haiku_model="claude-haiku-4-5",
        sonnet_model="claude-sonnet-4-5",
        http=http,
    )
    r = client.haiku("x", op="op", run_id="rid")
    # _PRICES["claude-haiku-4-5"]["in"] = 0.80 per million tokens
    assert r.cost_usd == pytest.approx(0.80)


def test_budget_cap_raises_before_call(tmp_path):
    # Pre-seed budget log so month_to_date() is over cap
    budget_log = Path(tmp_path / "b.jsonl")
    budget_log.parent.mkdir(parents=True, exist_ok=True)
    from datetime import UTC, datetime
    ts = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    budget_log.write_text(json.dumps({
        "ts": ts, "v": 1, "model": "x", "input_tokens": 1, "output_tokens": 1,
        "cost_usd": 999.0, "op": "seed", "run_id": "seed",
    }) + "\n")

    http = _http_mock()  # no responses queued → would error if called
    client = OpenRouterClient(
        api_key="or-xxx",
        budget=BudgetTracker(str(budget_log), 0.001),
        haiku_model="claude-haiku-4-5",
        sonnet_model="claude-sonnet-4-5",
        http=http,
    )
    with pytest.raises(BudgetExceeded):
        client.haiku("x", op="op", run_id="rid")
    http.post.assert_not_called()


def test_retries_on_5xx_then_succeeds(tmp_path):
    http = _http_mock(_transient_response(503), _transient_response(502), _ok_response("yes"))
    client = OpenRouterClient(
        api_key="or-xxx",
        budget=BudgetTracker(str(tmp_path / "b.jsonl"), 5.0),
        haiku_model="claude-haiku-4-5",
        sonnet_model="claude-sonnet-4-5",
        http=http,
        retry_max=3,
        retry_base_seconds=0.0,  # no real sleep
    )
    r = client.haiku("x", op="op", run_id="rid")
    assert r.text == "yes"
    assert http.post.call_count == 3


def test_raises_after_exhausting_retries(tmp_path):
    http = _http_mock(*[_transient_response(503) for _ in range(4)])
    client = OpenRouterClient(
        api_key="or-xxx",
        budget=BudgetTracker(str(tmp_path / "b.jsonl"), 5.0),
        haiku_model="claude-haiku-4-5",
        sonnet_model="claude-sonnet-4-5",
        http=http,
        retry_max=3,
        retry_base_seconds=0.0,
    )
    with pytest.raises(httpx.HTTPStatusError):
        client.haiku("x", op="op", run_id="rid")


def test_make_client_picks_openrouter_when_env_set(tmp_path, monkeypatch):
    from vault_mem_keeper.llm.client import make_client
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-xxx")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    budget = BudgetTracker(str(tmp_path / "b.jsonl"), 5.0)
    client = make_client(budget=budget, haiku_model="claude-haiku-4-5",
                         sonnet_model="claude-sonnet-4-5")
    assert type(client).__name__ == "OpenRouterClient"
    assert client.has_key() is True


def test_make_client_falls_back_to_anthropic(tmp_path, monkeypatch):
    from vault_mem_keeper.llm.client import make_client
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-xxx")
    budget = BudgetTracker(str(tmp_path / "b.jsonl"), 5.0)
    client = make_client(budget=budget, haiku_model="claude-haiku-4-5",
                         sonnet_model="claude-sonnet-4-5")
    assert type(client).__name__ == "AnthropicClient"


def test_make_client_no_keys_returns_anthropic_without_key(tmp_path, monkeypatch):
    from vault_mem_keeper.llm.client import make_client
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    budget = BudgetTracker(str(tmp_path / "b.jsonl"), 5.0)
    client = make_client(budget=budget, haiku_model="claude-haiku-4-5",
                         sonnet_model="claude-sonnet-4-5")
    assert type(client).__name__ == "AnthropicClient"
    assert client.has_key() is False
