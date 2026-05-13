"""OpenRouter adapter that mimics the AnthropicClient surface.

OpenRouter exposes only an OpenAI-compatible `/v1/chat/completions`
endpoint (not Anthropic's `/v1/messages`), so we POST directly via httpx
rather than route the Anthropic SDK through it. The wrapper exposes the
same `haiku(prompt, ...)` / `sonnet(prompt, ...)` methods returning the
same `LlmResponse` so callers (`ops/contradict`, `ops/summarize`) are
provider-agnostic."""

import time
from typing import Any

import httpx

from .budget import BudgetTracker
from .client import BudgetExceeded, LlmResponse, _cost  # noqa: PLC2701

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
_DEFAULT_TIMEOUT_S = 60.0
_VENDOR_PREFIX = "anthropic/"


def _prefix_model(name: str) -> str:
    return name if "/" in name else f"{_VENDOR_PREFIX}{name}"


class OpenRouterClient:
    """Drop-in replacement for AnthropicClient that calls OpenRouter."""

    def __init__(
        self,
        *,
        api_key: str | None,
        budget: BudgetTracker,
        haiku_model: str,
        sonnet_model: str,
        base_url: str = DEFAULT_BASE_URL,
        http: httpx.Client | None = None,
        retry_max: int = 3,
        retry_base_seconds: float = 1.0,
    ) -> None:
        self._api_key = api_key
        self._budget = budget
        self._haiku_model = _prefix_model(haiku_model)
        self._sonnet_model = _prefix_model(sonnet_model)
        self._base_url = base_url.rstrip("/")
        self._retry_max = retry_max
        self._retry_base = retry_base_seconds
        self._http = http or (
            httpx.Client(
                base_url=self._base_url,
                headers={
                    "Authorization": f"Bearer {api_key}" if api_key else "",
                    "HTTP-Referer": "https://github.com/ashishdhiman/vault-mem",
                    "X-Title": "vault-mem-keeper",
                },
                timeout=_DEFAULT_TIMEOUT_S,
            )
            if api_key else None
        )

    def has_key(self) -> bool:
        return bool(self._api_key)

    def haiku(self, prompt: str, *, op: str, run_id: str,
              max_tokens: int = 256) -> LlmResponse:
        return self._call(self._haiku_model, prompt, op=op, run_id=run_id, max_tokens=max_tokens)

    def sonnet(self, prompt: str, *, op: str, run_id: str,
               max_tokens: int = 1500) -> LlmResponse:
        return self._call(self._sonnet_model, prompt, op=op, run_id=run_id, max_tokens=max_tokens)

    def _call(self, model: str, prompt: str, *, op: str, run_id: str,
              max_tokens: int) -> LlmResponse:
        if self._budget.is_exceeded():
            raise BudgetExceeded(
                f"Monthly cap reached (${self._budget.month_to_date():.4f} >= cap)"
            )
        if self._http is None:
            raise RuntimeError("OpenRouterClient invoked without an API key")

        payload: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "usage": {"include": True},  # ask OpenRouter to include cost
        }

        attempt = 0
        last_err: Exception | None = None
        while attempt <= self._retry_max:
            try:
                resp = self._http.post("/chat/completions", json=payload)
                if resp.status_code in (429, 500, 502, 503, 504):
                    if attempt == self._retry_max:
                        resp.raise_for_status()
                    time.sleep(self._retry_base * (2 ** attempt))
                    attempt += 1
                    last_err = httpx.HTTPStatusError(
                        f"transient {resp.status_code}", request=resp.request, response=resp,
                    )
                    continue
                resp.raise_for_status()
                data = resp.json()
                break
            except (httpx.HTTPStatusError, httpx.RequestError) as e:
                if attempt == self._retry_max:
                    raise
                time.sleep(self._retry_base * (2 ** attempt))
                last_err = e
                attempt += 1
        else:  # pragma: no cover  — retry loop should always break or raise
            raise last_err if last_err else RuntimeError("retry loop fell through")

        choices = data.get("choices") or []
        text = ""
        if choices:
            msg = choices[0].get("message") or {}
            content = msg.get("content")
            if isinstance(content, list):
                # Some OpenRouter responses use OpenAI's tool-style content blocks
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text += str(block.get("text", ""))
            elif isinstance(content, str):
                text = content

        usage = data.get("usage") or {}
        in_tokens = int(usage.get("prompt_tokens") or 0)
        out_tokens = int(usage.get("completion_tokens") or 0)
        # Prefer OpenRouter's reported cost; fall back to our price table by base name.
        reported_cost = usage.get("cost")
        if reported_cost is not None:
            cost_usd = float(reported_cost)
        else:
            base_model = model.split("/", 1)[-1]
            cost_usd = _cost(base_model, in_tokens, out_tokens)

        self._budget.record_call(
            model=model, input_tokens=in_tokens, output_tokens=out_tokens,
            cost_usd=cost_usd, op=op, run_id=run_id,
        )
        stop_reason = None
        if choices:
            stop_reason = choices[0].get("finish_reason")
        return LlmResponse(
            text=text, model=model,
            input_tokens=in_tokens, output_tokens=out_tokens,
            cost_usd=cost_usd, stop_reason=stop_reason,
        )

    def close(self) -> None:  # pragma: no cover
        if self._http is not None:
            self._http.close()
