import type { AggregateMetrics, QuestionMetrics, QuestionResult } from "./types.js";

/**
 * Score one question. `returned` is the full ordered list of memory ids
 * the context tool surfaced; only the first `topK` count toward precision.
 *
 * A question "passes" when recall == 1.0 — i.e. every expected id appeared
 * within top_k. We use recall-as-pass because partial answers are
 * misleading: if the bundle is missing a critical decision, an agent
 * acting on the bundle is still going to make the wrong call.
 */
export function scoreQuestion(args: {
  id: string;
  question: string;
  expected: string[];
  returned: string[];
  topK: number;
}): QuestionResult {
  const considered = args.returned.slice(0, args.topK);
  const consideredSet = new Set(considered);
  const beyondTopK = args.returned.slice(args.topK);

  const hits: string[] = [];
  const missing: string[] = [];
  for (const e of args.expected) {
    if (consideredSet.has(e)) hits.push(e);
    else missing.push(e);
  }

  const hitCount = hits.length;
  const expectedCount = args.expected.length;
  const returnedCount = considered.length;
  const precision = returnedCount === 0 ? 0 : hitCount / returnedCount;
  const recall = expectedCount === 0 ? 1 : hitCount / expectedCount;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const metrics: QuestionMetrics = {
    precision,
    recall,
    f1,
    expectedCount,
    returnedCount,
    hitCount,
  };

  return {
    id: args.id,
    question: args.question,
    expected: args.expected,
    returned: considered,
    hits,
    missing,
    metrics,
    passed: recall === 1.0,
    beyondTopK,
  };
}

/**
 * Micro-average across questions: sum hits / sum expected for recall,
 * sum hits / sum returned for precision. F1 derived from the aggregates.
 */
export function aggregate(results: QuestionResult[]): AggregateMetrics {
  let totalExpected = 0;
  let totalReturned = 0;
  let totalHits = 0;
  let passed = 0;
  for (const r of results) {
    totalExpected += r.metrics.expectedCount;
    totalReturned += r.metrics.returnedCount;
    totalHits += r.metrics.hitCount;
    if (r.passed) passed++;
  }
  const precision = totalReturned === 0 ? 0 : totalHits / totalReturned;
  const recall = totalExpected === 0 ? 1 : totalHits / totalExpected;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const passRate = results.length === 0 ? 0 : passed / results.length;
  return { precision, recall, f1, passRate, totalExpected, totalReturned, totalHits };
}
