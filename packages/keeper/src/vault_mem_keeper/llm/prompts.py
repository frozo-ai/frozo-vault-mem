"""Prompt templates for the Anthropic-driven keeper ops.

Three callable builders: contradict_prefilter, contradict_judge,
summary_for_period. Plus parse_judge_response() to extract structured
output from Sonnet's JSON-flavored reply (tolerant of leading prose)."""

import json
import re
from dataclasses import dataclass
from typing import Any


@dataclass
class JudgeResponse:
    has_contradiction: bool
    severity: str
    reasoning: str
    suggested_action: str


def _truncate(text: str, max_chars: int = 500) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars - 3] + "..."


def contradict_prefilter(
    *, a_title: str, a_body: str, b_title: str, b_body: str,
) -> str:
    return f"""You are helping classify pairs of memory notes.

Below are two notes from a personal knowledge vault. Determine whether
they are about the **same topic** (same project, same subsystem, or same
specific decision/observation/learning).

Reply with **only** the word "yes" or "no". No explanation.

Note A: {a_title}
{_truncate(a_body)}

Note B: {b_title}
{_truncate(b_body)}

Same topic? (yes/no)"""


def contradict_judge(
    *, a_id: str, b_id: str,
    a_title: str, a_body: str,
    b_title: str, b_body: str,
) -> str:
    return f"""You are auditing a personal knowledge vault for contradictions.

Two memories are below; both have been flagged as being about the same
topic. Decide whether they actually **contradict** (assert mutually
incompatible facts about the same subject) or merely cover **different
facets** of the same topic without disagreement.

Reply in **JSON** with these exact fields:

- has_contradiction: boolean
- severity: "low" | "medium" | "high"
  ("low" = nuance/scope; "medium" = real but recoverable; "high" = direct reversal)
- reasoning: brief explanation citing specifics from both memories
- suggested_action: one of:
  * "supersede_M_with_N" (M is older/wrong; N replaces it)
  * "supersede_N_with_M" (N is older/wrong; M replaces it)
  * "merge" (both have value; combine into a unified memory)
  * "both_active_different_facets" (no real contradiction)
  * "none" (no action — keep both as-is)

Memory M (id: {a_id}): {a_title}
{_truncate(a_body, 800)}

Memory N (id: {b_id}): {b_title}
{_truncate(b_body, 800)}

Respond with only the JSON object. No preamble, no markdown fences."""


_PERIOD_HEADER = {
    "daily":   "Daily summary",
    "weekly":  "Weekly summary",
    "monthly": "Monthly summary",
}


def summary_for_period(
    *, project: str, period: str, memories: list[dict[str, Any]],
) -> str:
    header = _PERIOD_HEADER[period]
    sections = []
    for m in memories:
        sections.append(
            f"- [{m['type']}] {m['title']}\n  id: {m['id']}\n  {_truncate(m.get('content', ''), 300)}"  # noqa: E501
        )
    body = "\n\n".join(sections)
    return f"""{header} for project: {project}

Below are memories from this project from the relevant time window. Produce
a concise markdown summary (300–800 words) that:

1. Lists the key decisions (under a "## Decisions" heading).
2. Highlights notable observations and learnings (under "## Observations").
3. Calls out open questions or todos (under "## Open").

Be specific — cite memory titles when useful. Don't invent facts not
present below. Don't include preamble or postscript outside the headings.

Memories:

{body}"""


def parse_judge_response(text: str) -> JudgeResponse | None:
    """Extract the first {{...}} JSON object from text. Tolerant of prose preamble."""
    if not text:
        return None
    # Find the outermost {...}
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    try:
        return JudgeResponse(
            has_contradiction=bool(data["has_contradiction"]),
            severity=str(data.get("severity", "low")),
            reasoning=str(data.get("reasoning", "")),
            suggested_action=str(data.get("suggested_action", "none")),
        )
    except (KeyError, TypeError):
        return None
