# Launch drafts

Drafts of public-facing posts for the OSS announcement. Not shipped yet —
edit and confirm before posting to each venue.

| File | Venue | Tone |
|---|---|---|
| [`show-hn.md`](./show-hn.md) | Show HN | Dry, technical, acknowledge trade-offs |
| [`reddit-localllama.md`](./reddit-localllama.md) | r/LocalLLaMA | Practical, local-first framing |
| [`twitter-thread.md`](./twitter-thread.md) | Twitter / X | 8-tweet thread, visual + emotional |

## Pre-launch checklist

Before posting to any venue:

- [ ] Repo CI green on `main` (check the badge in README)
- [ ] `pnpm --filter @vault-mem/mcp test` clean
- [ ] `cd packages/keeper && uv run pytest` clean
- [ ] `vault-mem-mcp doctor` against a fresh `init`'d vault returns PASS on every check
- [ ] `vault-mem-mcp export-skill` smoke test produces a parseable Claude bundle
- [ ] Every link in the post resolves (especially docs/INSTALL.md, docs/ARCHITECTURE.md)
- [ ] No personal paths / tokens / vault contents in any committed file
- [ ] Screenshots prepared:
  - `vault-mem-mcp doctor` output
  - A SKILL.md rendered in a code preview
  - Obsidian showing the vault folder (optional but punchy)
- [ ] Posting account checked: no recent controversial activity, posting from
  the right handle (founder, not company brand)
- [ ] Time-zone: Tue/Wed 9-11am PT for Show HN; r/LocalLLaMA is more tolerant
  but same window works. Twitter: 10am-1pm IST.
- [ ] Browser logged out of all auto-fill / preview-fetcher accounts for the
  first 30 min after posting (avoids accidental upvote-self trip-ups)

## Sequencing

Post in this order so each surface reinforces the next:

1. **Twitter thread** first (free, fast feedback, can warm up the network)
2. **Show HN** next (highest-friction; want it to land cleanly with no
   broken-link surprises)
3. **r/LocalLLaMA** after Show HN gets to ~30 points (or skip if HN dies; the
   audiences overlap, no point burning the venue if HN didn't catch)

Wait at least an hour between posts. Don't cross-link them (Reddit and HN
both penalize this).

## Post-launch tracking

Capture metrics for the day:

- HN points + comments at 1h, 6h, 24h
- Reddit upvotes + comments at same intervals
- Twitter impressions, retweets, replies
- GitHub stars before / 1h / 24h
- README traffic (GitHub insights)

Save the numbers to a vault-mem memory of type `observation` so we can
look back at what this launch actually moved.
