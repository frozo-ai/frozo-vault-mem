# Eval gold sets

This directory holds **gold-set Q&A pairs** for testing memory retrieval
quality. One subdirectory per project, with one or more `.json` files per
project.

```
evals/
├── README.md         (this file)
└── <project>/
    ├── smoke.json
    └── regression.json
```

## Why

The vault-mem MCP server exposes `memory.context(project, query)` which
returns a token-budgeted bundle of the most relevant memories. Whether the
"right" memories surface for a given question is a quality property worth
testing.

A gold set encodes **expected citations** — memory ids that should appear in
the bundle when a human asks question Q. The eval harness then runs each
question through `memory.context` and computes precision / recall against
the expected ids.

## Running an eval

```bash
# Run every gold set under evals/<project>/
vault-mem-mcp eval run <project>

# Run a specific set
vault-mem-mcp eval run <project> --set smoke

# CI gating: exits non-zero if F1 < 0.7
vault-mem-mcp eval run <project> --min-f1 0.7
```

See `_system/schema/eval-set.json` for the formal schema and the comments in
each field.

## Authoring a gold set

1. Pick questions a teammate would actually ask Claude about this
   project ("what did we decide about auth?", "what tooling are we using
   for embeddings?").
2. For each, list the memory ids in your vault that contain the right
   answer. Get them from `memory_search` or by browsing `~/vault-mem/`.
3. Save the file as `evals/<project>/<set-name>.json` following the schema.

## Recommended sizes

| Purpose | Size | Notes |
|---|---|---|
| `smoke.json` | 5–10 questions | Fast CI gate. Run on every change. |
| `dogfood.json` | ~50 questions | Your own usage as proxy for real users. Catches retrieval regressions. |
| `<partner>.json` (design partner / production project) | **≥ 50 questions** | Required threshold per PRD §12 Risk #10. Adversarial questions added monthly. |

Smaller sets give actionable feedback fast; larger sets are needed before a project can claim "we tested retrieval against real usage." Both have their place — don't ship a `smoke` as if it were a partner gold set.

## Scoring

Per question:
- **Precision** = `|expected ∩ returned| / |returned (top_k)|`
- **Recall**    = `|expected ∩ returned| / |expected|`
- **F1**        = harmonic mean

Aggregate metrics are micro-averaged across all questions.
