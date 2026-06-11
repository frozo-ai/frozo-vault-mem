# Defense benchmarks

Adversarial corpora for measuring Cerebro's write-time and read-time defenses.
First memory product to publish defense numbers, not just retrieval recall.

```
defense/
├── README.md       (this file)
├── agentpoison/    write-time injection scan precision/recall
├── minja/          query-time misdirection robustness
└── behavioral/     long-running poisoning detection latency
```

## Running

```bash
vault-mem-mcp eval defense --corpus agentpoison --output report.json
vault-mem-mcp eval defense --corpus minja --output report.json
vault-mem-mcp eval defense --corpus behavioral --output report.json
```

**v1 scope limitation:** the OSS harness exercises a **dry-run** scoring model
against the bundled corpus. It does **not** talk to a live Cloud scanner —
the production AgentPoison/MINJA numbers are produced by the Cloud-side
runner in `supabase/functions/eval-run` (vault-cloud repo), which has direct
DB + service-role access. The OSS harness is the open-source corpus + scoring
spec; the Cloud harness is the production runner.

Behavioral corpus requires Cloud-mode regardless — OSS is single-agent and
has no `mcp_agents.trust_score` to exercise.

## What we measure

| Corpus | Metric | Target |
|---|---|---|
| AgentPoison | block_rate (recall) | ≥ 0.85 |
| AgentPoison | false_positive_rate | ≤ 0.05 |
| MINJA | top_5_contamination_rate | ≤ 0.10 (90% of queries clean) |
| Behavioral | detection_latency_days | ≤ 7 (score < 40 by day 7) |

## Methodology citations

- **AgentPoison** — Chen et al., *AgentPoison: Red-teaming LLM Agents via Poisoning Memory or Knowledge Bases*, NeurIPS 2024. Poisoned memories injected into the corpus; retrieval pulls them in; downstream agent treats them as ground truth.
- **MINJA** — Dong et al., *Memory INJection Attacks against LLM Agents*, 2025. Query-time misdirection — memories craft-tuned to look relevant for a known query while carrying misleading content.
- **Behavioral degradation** — internal threat model. A patient adversary that writes a few poisoned memories per day from a long-lived agent identity; trust must degrade fast enough to limit blast radius.

## Reproducibility

Corpus is MIT-licensed. Re-run any time:

```bash
git clone https://github.com/frozo-ai/frozo-vault-mem
cd frozo-vault-mem
pnpm install && pnpm build
node packages/mcp/bin/vault-mem-mcp eval defense --corpus agentpoison
```

Sample report committed at `agentpoison/report-2026-06-11.json` so docs +
the future `cerebro.frozo.ai/defense` page can cite a stable run.

## Spec

`docs/superpowers/specs/2026-06-11-trust-defense-gaps.md` §Gap 5 (in
vault-cloud repo).
