// CLI for `vault-mem-mcp eval defense --corpus <name>`.
// See vault-template/evals/defense/README.md for usage + scope notes.

import { writeFileSync } from "node:fs";
import {
  loadAgentPoison,
  loadBehavioral,
  loadMinja,
  runAgentPoison,
  runBehavioralPlaceholder,
  runMinjaPlaceholder,
  type DefenseCorpus,
  type DefenseReport,
} from "../eval/defense/index.js";

export interface RunDefenseCliOpts {
  corpus: DefenseCorpus;
  /** Optional vault to override the bundled corpus. */
  vault?: string;
  /** If set, write the report JSON to this path. */
  outputPath?: string;
}

export interface RunDefenseCliResult {
  report: DefenseReport;
  exitCode: number;
}

export async function runDefenseCli(opts: RunDefenseCliOpts): Promise<RunDefenseCliResult> {
  let report: DefenseReport;
  switch (opts.corpus) {
    case "agentpoison": {
      const corpus = loadAgentPoison(opts.vault);
      report = await runAgentPoison(corpus);
      break;
    }
    case "minja": {
      const corpus = loadMinja(opts.vault);
      report = runMinjaPlaceholder(corpus);
      break;
    }
    case "behavioral": {
      const corpus = loadBehavioral(opts.vault);
      report = runBehavioralPlaceholder(corpus);
      break;
    }
    default:
      throw new Error(
        `Unknown defense corpus: ${opts.corpus}. Expected agentpoison | minja | behavioral.`,
      );
  }

  process.stdout.write(renderReport(report));
  process.stdout.write("\n");

  if (opts.outputPath) {
    writeFileSync(opts.outputPath, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(`Wrote ${opts.outputPath}\n`);
  }

  return { report, exitCode: 0 };
}

function renderReport(r: DefenseReport): string {
  const head = `defense corpus: ${r.corpus} (mode: ${r.mode}, version ${r.version})`;
  if (r.corpus === "agentpoison") {
    const lines = [
      head,
      `  attacks: ${r.n_attacks}    benign: ${r.n_benign}`,
      `  precision: ${pct(r.precision)}    recall: ${pct(r.recall)}`,
      `  false-positive rate: ${pct(r.false_positive_rate)}    false-negative rate: ${pct(r.false_negative_rate)}`,
      `  by category:`,
    ];
    for (const [cat, stats] of Object.entries(r.by_category)) {
      lines.push(`    ${cat.padEnd(28)} n=${stats.n}  tp=${stats.tp}  recall=${pct(stats.recall)}`);
    }
    return lines.join("\n");
  }
  if (r.corpus === "minja") {
    return [
      head,
      `  queries: ${r.n_queries}    attacks: ${r.n_attacks}`,
      `  top_5_contamination_rate: ${pct(r.top_5_contamination_rate)}`,
      r.notes ? `  notes: ${r.notes}` : "",
    ].filter(Boolean).join("\n");
  }
  // behavioral
  return [
    head,
    `  agent: ${r.agent_id}`,
    `  detected_at_day: ${r.detected_at_day ?? "(never)"}`,
    `  final_score: ${r.final_score}`,
    `  30-day quarantine rate: ${pct(r.thirty_day_quarantine_rate)}`,
    r.notes ? `  notes: ${r.notes}` : "",
  ].filter(Boolean).join("\n");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
