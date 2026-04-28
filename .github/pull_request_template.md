## Summary

<!-- 1-3 bullets on what this PR changes and why. -->

## Type

- [ ] feat (new feature or behavior)
- [ ] fix (bug fix)
- [ ] docs (docs-only change)
- [ ] chore / refactor / test (non-functional)

## Tests

- [ ] `pnpm --filter @vault-mem/mcp test` passes
- [ ] `pnpm --filter @vault-mem/mcp typecheck` passes
- [ ] `cd packages/keeper && uv run pytest` passes
- [ ] `cd packages/keeper && uv run ruff check src tests` passes
- [ ] Added tests for new behavior, or N/A (explain why)

## Spec / schema impact

- [ ] No schema change
- [ ] Additive schema change (new optional field) — documented in CHANGELOG
- [ ] Breaking schema change — REQUIRES migration plan; opened a discussion first

## Checklist

- [ ] Conventional commit messages (`feat(scope): …`, `fix(scope): …`, `docs: …`)
- [ ] Updated relevant docs (README, docs/, package README) if behavior changed
- [ ] No personal/sensitive content in committed files
- [ ] Diff is focused (one concern per PR)

## Related issues

<!-- Closes #N, refs #M -->
