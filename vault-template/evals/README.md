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

1. Pick 5–20 questions a teammate would actually ask Claude about this
   project ("what did we decide about auth?", "what tooling are we using
   for embeddings?").
2. For each, list the memory ids in your vault that contain the right
   answer. Get them from `memory_search` or by browsing `~/vault-mem/`.
3. Save the file as `evals/<project>/<set-name>.json` following the schema.

Keep gold sets **small** (5–20 questions) and **focused** (one set per
purpose: smoke, release-gate, particular feature). Big sets are hard to
maintain; small focused sets give actionable feedback.

## Scoring

Per question:
- **Precision** = `|expected ∩ returned| / |returned (top_k)|`
- **Recall**    = `|expected ∩ returned| / |expected|`
- **F1**        = harmonic mean

Aggregate metrics are micro-averaged across all questions.
