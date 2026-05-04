import pytest

from vault_mem_keeper.llm.prompts import (
    contradict_prefilter,
    contradict_judge,
    summary_for_period,
    parse_judge_response,
)


def test_prefilter_includes_both_titles_and_bodies():
    s = contradict_prefilter(
        a_title="Use Supabase", a_body="Supabase has DPDP-compatible hosting.",
        b_title="Use Auth0", b_body="Auth0 is convenient.",
    )
    assert "Use Supabase" in s
    assert "Use Auth0" in s
    assert "yes/no" in s.lower() or "yes or no" in s.lower()


def test_judge_request_specifies_json_output():
    s = contradict_judge(
        a_title="Use Supabase", a_body="...", b_title="Migrate to Auth0", b_body="...",
        a_id="mem_1", b_id="mem_2",
    )
    assert "json" in s.lower()
    assert "has_contradiction" in s
    assert "severity" in s
    assert "suggested_action" in s
    # Both ids present so the response can reference them by id
    assert "mem_1" in s and "mem_2" in s


def test_parse_judge_response_extracts_fields():
    raw = (
        '{"has_contradiction": true, "severity": "high", '
        '"reasoning": "The two specify different auth providers", '
        '"suggested_action": "supersede_M_with_N"}'
    )
    j = parse_judge_response(raw)
    assert j.has_contradiction is True
    assert j.severity == "high"
    assert j.suggested_action == "supersede_M_with_N"


def test_parse_judge_response_handles_extra_text():
    """Sonnet sometimes prefixes the JSON with prose; parse should be tolerant."""
    raw = (
        "Here is my analysis:\n"
        '{"has_contradiction": false, "severity": "low", '
        '"reasoning": "different facets", "suggested_action": "none"}'
    )
    j = parse_judge_response(raw)
    assert j.has_contradiction is False
    assert j.suggested_action == "none"


def test_parse_judge_response_returns_none_on_unparseable():
    j = parse_judge_response("not json at all")
    assert j is None


def test_summary_for_period_includes_titles_and_period():
    memories = [
        {"id": "mem_1", "type": "decision", "title": "Use Supabase", "content": "..."},
        {"id": "mem_2", "type": "observation", "title": "Free tier limits", "content": "..."},
    ]
    s = summary_for_period(project="myapp", period="daily", memories=memories)
    assert "myapp" in s
    assert "daily" in s.lower()
    assert "Use Supabase" in s
    assert "Free tier limits" in s
