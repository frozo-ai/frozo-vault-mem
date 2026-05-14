import type { EvalReport, QuestionResult } from "./types.js";

const STATUS_SYMBOL = {
  pass: "✓",
  partial: "◐",
  fail: "✗",
} as const;

function questionStatus(r: QuestionResult): keyof typeof STATUS_SYMBOL {
  if (r.passed) return "pass";
  if (r.metrics.hitCount > 0) return "partial";
  return "fail";
}

function pct(x: number): string {
  return (x * 100).toFixed(0) + "%";
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}

/**
 * Render the report as plain text for stdout. Designed to be diff-friendly
 * across runs so CI logs are useful for spotting regressions.
 */
export function renderText(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`Eval: ${report.project}/${report.set}  (${report.total} questions)`);
  lines.push("─".repeat(64));

  const idWidth = Math.max(2, ...report.questions.map((q) => q.id.length));
  for (const q of report.questions) {
    const sym = STATUS_SYMBOL[questionStatus(q)];
    const expectedHits = `${q.metrics.hitCount}/${q.metrics.expectedCount}`;
    lines.push(
      `  ${sym}  ${pad(q.id, idWidth)}  ` +
      `precision=${pct(q.metrics.precision)}  ` +
      `recall=${pct(q.metrics.recall)}  ` +
      `hits=${expectedHits}`
    );
    if (q.missing.length > 0) {
      lines.push(`        missing: ${q.missing.join(", ")}`);
    }
  }

  lines.push("─".repeat(64));
  const m = report.metrics;
  lines.push(
    `Overall: precision=${pct(m.precision)}  recall=${pct(m.recall)}  ` +
    `F1=${pct(m.f1)}  pass=${report.passed}/${report.total} (${pct(m.passRate)})`
  );
  return lines.join("\n") + "\n";
}

/**
 * Render as JSON for CI consumption. Stable shape across runs.
 */
export function renderJson(report: EvalReport): string {
  return JSON.stringify(
    {
      project: report.project,
      set: report.set,
      vault: report.vault,
      run_at: report.runAt,
      total: report.total,
      passed: report.passed,
      metrics: report.metrics,
      questions: report.questions.map((q) => ({
        id: q.id,
        question: q.question,
        expected: q.expected,
        returned: q.returned,
        hits: q.hits,
        missing: q.missing,
        beyond_top_k: q.beyondTopK,
        passed: q.passed,
        metrics: q.metrics,
      })),
    },
    null,
    2
  ) + "\n";
}
