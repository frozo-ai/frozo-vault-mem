import { describe, expect, it } from "vitest";
import { aggregate, scoreQuestion } from "./scorer.js";

describe("scoreQuestion", () => {
  it("hits=1 expected=1 returned=1 → all metrics 1, passes", () => {
    const r = scoreQuestion({
      id: "q1", question: "?", topK: 10,
      expected: ["mem_2026-05-01_aaa111"],
      returned: ["mem_2026-05-01_aaa111"],
    });
    expect(r.metrics.precision).toBe(1);
    expect(r.metrics.recall).toBe(1);
    expect(r.metrics.f1).toBe(1);
    expect(r.passed).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("partial recall: 1 of 2 expected found → fails (passed = recall==1)", () => {
    const r = scoreQuestion({
      id: "q1", question: "?", topK: 10,
      expected: ["a", "b"].map((s) => `mem_2026-05-01_${s.repeat(6)}`),
      returned: ["mem_2026-05-01_aaaaaa", "mem_2026-05-01_xxxxxx"],
    });
    expect(r.metrics.hitCount).toBe(1);
    expect(r.metrics.recall).toBe(0.5);
    expect(r.metrics.precision).toBe(0.5);
    expect(r.passed).toBe(false);
    expect(r.missing).toEqual(["mem_2026-05-01_bbbbbb"]);
  });

  it("respects top_k — items beyond the cutoff don't count toward precision/recall", () => {
    const r = scoreQuestion({
      id: "q1", question: "?", topK: 2,
      expected: ["mem_2026-05-01_ccccCC".toLowerCase()],
      returned: [
        "mem_2026-05-01_xxxxxx",
        "mem_2026-05-01_yyyyyy",
        "mem_2026-05-01_cccccc",  // beyond top_k=2
      ],
    });
    expect(r.metrics.returnedCount).toBe(2);
    expect(r.metrics.hitCount).toBe(0);
    expect(r.metrics.precision).toBe(0);
    expect(r.metrics.recall).toBe(0);
    expect(r.beyondTopK).toEqual(["mem_2026-05-01_cccccc"]);
  });

  it("zero returned items → precision=0 recall=0 no crash", () => {
    const r = scoreQuestion({
      id: "q1", question: "?", topK: 10,
      expected: ["mem_2026-05-01_aaaaaa"],
      returned: [],
    });
    expect(r.metrics.precision).toBe(0);
    expect(r.metrics.recall).toBe(0);
    expect(r.metrics.f1).toBe(0);
  });
});

describe("aggregate", () => {
  it("micro-averages across all questions", () => {
    // q1: 1 of 2 expected, 2 returned  → hits 1, expected 2, returned 2
    // q2: 2 of 2 expected, 2 returned  → hits 2, expected 2, returned 2
    // total: hits 3, expected 4, returned 4
    // precision = 3/4 = 0.75, recall = 3/4 = 0.75
    const results = [
      scoreQuestion({
        id: "q1", question: "?", topK: 10,
        expected: ["mem_2026-05-01_aaaaaa", "mem_2026-05-01_bbbbbb"],
        returned: ["mem_2026-05-01_aaaaaa", "mem_2026-05-01_zzzzzz"],
      }),
      scoreQuestion({
        id: "q2", question: "?", topK: 10,
        expected: ["mem_2026-05-01_cccccc", "mem_2026-05-01_dddddd"],
        returned: ["mem_2026-05-01_cccccc", "mem_2026-05-01_dddddd"],
      }),
    ];
    const agg = aggregate(results);
    expect(agg.totalExpected).toBe(4);
    expect(agg.totalReturned).toBe(4);
    expect(agg.totalHits).toBe(3);
    expect(agg.precision).toBe(0.75);
    expect(agg.recall).toBe(0.75);
    expect(agg.f1).toBeCloseTo(0.75);
    expect(agg.passRate).toBe(0.5);  // q2 passed, q1 did not
  });

  it("empty results → zeros (no NaN)", () => {
    const agg = aggregate([]);
    expect(agg.precision).toBe(0);
    expect(agg.f1).toBe(0);
    expect(agg.passRate).toBe(0);
  });
});
