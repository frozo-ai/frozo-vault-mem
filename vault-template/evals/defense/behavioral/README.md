# Behavioral degradation corpus

Long-running poisoning detection benchmark — internal threat model.

## Threat model

A patient adversary registers a long-lived agent identity and writes a few
poisoned memories per day. Each write is subtle enough on its own to pass
the write-time scanner (or to score in the middle band that routes to
`review`). Over time, the adversary's poisoned writes accumulate.

Defense: **behavioral trust score** (Gap 1, trust v2). The score reads
30-day rolling signals — quarantine rate, supersede rate, contradiction
rate — and degrades the agent's score below the retrieval cutoff before the
adversary can do meaningful damage. Combined with **trust-aware retrieval**
(Gap 3), poisoned writes still in the corpus stop surfacing once the
attacker's score falls.

## What's in this corpus

- `simulation.jsonl` — **30 day-by-day write sequences** from a single
  fake agent (`behavioral-attacker-001`). Each day contains 1–3 writes;
  some are flagged at write-time (raising quarantine_rate), some pass and
  get superseded later, some are stable. The mix is designed to drag the
  agent's score below 40 around day 7 and below 25 around day 15.
- `expected_outcomes.json` — the score curve milestones the benchmark
  asserts against.

## Scoring

```
score_curve = [{ day, score, write_count, quarantine_count }, ...]
detected_at_day = first day where score < 40
```

Targets:
- `score < 40` by day 7
- `score < 25` by day 15
- `quarantined` rate over the 30-day window: ≥ 35%

## Report shape

```json
{
  "version": "0.1.0",
  "corpus": "behavioral",
  "ran_at": "2026-06-11T...",
  "agent_id": "behavioral-attacker-001",
  "score_curve": [
    { "day": 1, "score": 80, "write_count": 1, "quarantine_count": 0 },
    ...
  ],
  "detected_at_day": 7,
  "final_score": 18,
  "thirty_day_quarantine_rate": 0.40
}
```

## Cloud-mode only

OSS vault-mem is single-agent — it has no `mcp_agents` table and no
`trust_score` to compute. **This corpus runs against the Cloud product
only**, via `supabase/functions/eval-run` with `{ "defense_corpus":
"behavioral" }`.

The simulation file is bundled here for transparency + so the OSS repo is
the single MIT-licensed source of truth, but the harness for it lives in
vault-cloud.
