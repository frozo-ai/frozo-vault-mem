export interface RankedHit {
  id: string;
  rank: number;
}

export interface FusedHit {
  id: string;
  score: number;
}

export function rrfMerge(
  fts: RankedHit[],
  sem: RankedHit[],
  k: number,
  limit: number,
): FusedHit[] {
  const scores = new Map<string, number>();
  for (const h of fts) {
    scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (k + h.rank));
  }
  for (const h of sem) {
    scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (k + h.rank));
  }
  const out: FusedHit[] = [];
  for (const [id, score] of scores) out.push({ id, score });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
