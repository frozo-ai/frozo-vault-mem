"""Thin Anthropic SDK wrapper with retry, response parsing, cost tracking.

Two methods: haiku() and sonnet(). Both:
1. Check budget; raise BudgetExceeded if over cap.
2. Call SDK with retry on 429/500 (up to retry_max times, exponential
   backoff from retry_base_seconds).
3. Parse usage tokens from response.
4. Compute cost from hardcoded price table.
5. Append per-call line to budget.jsonl.
6. Return LlmResponse(text, cost_usd, ...)."""

import os
import time
from dataclasses import dataclass
from typing import Any

from anthropic import APIStatusError, APITimeoutError

from .budget import BudgetTracker

# USD per million tokens
_PRICES = {
    "claude-haiku-4-5":   {"in": 0.80,  "out": 4.00},
    "claude-sonnet-4-7":  {"in": 3.00,  "out": 15.00},
}


class BudgetExceeded(RuntimeError):
    """Raised when the monthly budget cap is reached."""


@dataclass
class LlmResponse:
    text: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    stop_reason: str | None = None


def _cost(model: str, input_tokens: int, output_tokens: int) -> float:
    p = _PRICES.get(model)
    if not p:
        return 0.0
    return (input_tokens * p["in"] + output_tokens * p["out"]) / 1_000_000


class AnthropicClient:
    def __init__(
        self,
        *,
        sdk: Any,
        budget: BudgetTracker,
        haiku_model: str,
        sonnet_model: str,
        api_key: str | None,
        retry_max: int = 3,
        retry_base_seconds: float = 1.0,
    ) -> None:
        self._sdk = sdk
        self._budget = budget
        self._haiku_model = haiku_model
        self._sonnet_model = sonnet_model
        self._api_key = api_key
        self._retry_max = retry_max
        self._retry_base = retry_base_seconds

    def has_key(self) -> bool:
        return bool(self._api_key)

    def haiku(self, prompt: str, *, op: str, run_id: str, max_tokens: int = 256) -> LlmResponse:
        return self._call(self._haiku_model, prompt, op=op, run_id=run_id, max_tokens=max_tokens)

    def sonnet(self, prompt: str, *, op: str, run_id: str, max_tokens: int = 1500) -> LlmResponse:
        return self._call(self._sonnet_model, prompt, op=op, run_id=run_id, max_tokens=max_tokens)

    def _call(self, model: str, prompt: str, *, op: str, run_id: str, max_tokens: int) -> LlmResponse:
        if self._budget.is_exceeded():
            raise BudgetExceeded(
                f"Monthly cap reached (${self._budget.month_to_date():.4f} >= cap)"
            )
        attempt = 0
        last_err: Exception | None = None
        while attempt <= self._retry_max:
            try:
                msg = self._sdk.messages.create(
                    model=model,
                    max_tokens=max_tokens,
                    messages=[{"role": "user", "content": prompt}],
                )
                in_tokens = int(getattr(msg.usage, "input_tokens", 0))
                out_tokens = int(getattr(msg.usage, "output_tokens", 0))
                text = ""
                for block in (msg.content or []):
                    if getattr(block, "type", None) == "text":
                        text += block.text
                cost_usd = _cost(model, in_tokens, out_tokens)
                self._budget.record_call(
                    model=model, input_tokens=in_tokens,
                    output_tokens=out_tokens, cost_usd=cost_usd,
                    op=op, run_id=run_id,
                )
                return LlmResponse(
                    text=text, model=model, input_tokens=in_tokens,
                    output_tokens=out_tokens, cost_usd=cost_usd,
                    stop_reason=getattr(msg, "stop_reason", None),
                )
            except (APIStatusError, APITimeoutError) as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                if status not in (429, 500, 502, 503, 504) or attempt == self._retry_max:
                    raise
                wait = self._retry_base * (2 ** attempt)
                time.sleep(wait)
                last_err = e
                attempt += 1
        raise last_err if last_err else RuntimeError("retry loop fell through")


def make_client(budget: BudgetTracker, haiku_model: str, sonnet_model: str) -> AnthropicClient:
    """Factory using ANTHROPIC_API_KEY env var. Returns client with sdk=None
    when the key is missing — call has_key() first."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    sdk = None
    if api_key:
        from anthropic import Anthropic
        sdk = Anthropic(api_key=api_key)
    return AnthropicClient(
        sdk=sdk, budget=budget,
        haiku_model=haiku_model, sonnet_model=sonnet_model,
        api_key=api_key,
    )
