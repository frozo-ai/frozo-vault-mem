import { describe, expect, it } from "vitest";
import { rrfMerge, type RankedHit } from "./hybrid.js";

const hit = (id: string, rank: number): RankedHit => ({ id, rank });

describe("rrfMerge", () => {
  it("merges two disjoint lists by RRF score, descending", () => {
    const fts = [hit("a", 0), hit("b", 1), hit("c", 2)];
    const sem = [hit("d", 0), hit("e", 1), hit("f", 2)];
    const out = rrfMerge(fts, sem, 60, 6);
    // rank 0 in either list dominates → "a" and "d" tied
    expect(out.length).toBe(6);
    expect(out[0]!.score).toBeCloseTo(out[1]!.score, 5);
    expect(["a", "d"]).toContain(out[0]!.id);
  });

  it("boosts ids that appear in both lists", () => {
    const fts = [hit("shared", 0), hit("a", 1), hit("b", 2)];
    const sem = [hit("shared", 0), hit("c", 1), hit("d", 2)];
    const out = rrfMerge(fts, sem, 60, 5);
    expect(out[0]!.id).toBe("shared");
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it("respects the limit", () => {
    const fts = [hit("a", 0), hit("b", 1), hit("c", 2)];
    const sem = [hit("d", 0), hit("e", 1), hit("f", 2)];
    expect(rrfMerge(fts, sem, 60, 3).length).toBe(3);
  });

  it("handles empty FTS list", () => {
    expect(rrfMerge([], [hit("x", 0), hit("y", 1)], 60, 10)).toHaveLength(2);
    expect(rrfMerge([], [hit("x", 0)], 60, 10)[0]!.id).toBe("x");
  });

  it("handles empty semantic list", () => {
    expect(rrfMerge([hit("x", 0)], [], 60, 10)).toHaveLength(1);
  });

  it("returns empty when both lists empty", () => {
    expect(rrfMerge([], [], 60, 10)).toEqual([]);
  });

  it("ranks earlier positions higher (sanity)", () => {
    const fts = [hit("first", 0), hit("second", 1), hit("third", 2)];
    const sem: RankedHit[] = [];
    const out = rrfMerge(fts, sem, 60, 3);
    expect(out.map((x) => x.id)).toEqual(["first", "second", "third"]);
  });
});
