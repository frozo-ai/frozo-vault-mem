import { Command } from "commander";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server/index.js";
import { runInit } from "./cli/init.js";
import { runDoctor } from "./cli/doctor.js";
import { runReindex } from "./cli/reindex.js";
import { runTailAudit } from "./cli/tail-audit.js";
import { runExportSkill } from "./cli/export-skill.js";
import { runEvalCli } from "./cli/eval.js";
import { resolveVaultPath } from "./vault/paths.js";
import { createLogger } from "./log.js";

export const VERSION = "0.1.0";

async function runServer(vault: string): Promise<void> {
  const log = createLogger();
  const built = await buildServer({ vault });
  const transport = new StdioServerTransport();
  await built.server.connect(transport);
  log.info({ vault }, "vault-mem-mcp ready (stdio)");
  process.once("SIGINT", async () => { await built.shutdown(); process.exit(0); });
  process.once("SIGTERM", async () => { await built.shutdown(); process.exit(0); });
}

async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program.name("vault-mem-mcp").version(VERSION);

  program
    .command("init")
    .description("Materialize a new vault from the bundled template")
    .option("--target <path>", "Target directory", `${homedir()}/vault-mem`)
    .option("--git", "git init the new vault and make an initial commit")
    .action(async (opts: { target: string; git?: boolean }) => {
      const out = await runInit({ target: opts.target, git: opts.git });
      console.log(`Initialized vault at ${out.target}`);
    });

  program
    .command("doctor")
    .description("Validate vault structure and config")
    .option("--vault <path>", "Vault root", undefined)
    .action(async (opts: { vault?: string }) => {
      const vault = resolveVaultPath({ flag: opts.vault, env: process.env.VAULT_MEM_PATH });
      const result = await runDoctor({ vault });
      for (const c of result.checks) {
        console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  — " + c.detail : ""}`);
      }
      process.exit(result.ok ? 0 : 1);
    });

  program
    .command("reindex")
    .description("Drop and rebuild the FTS and/or embedding index")
    .option("--vault <path>", "Vault root", undefined)
    .option("--fts-only", "Only rebuild the FTS (SQLite) index; leave embeddings.lance untouched")
    .option("--semantic-only", "Only rebuild the Lance embedding index; leave the FTS index untouched")
    .action(async (opts: { vault?: string; ftsOnly?: boolean; semanticOnly?: boolean }) => {
      const vault = resolveVaultPath({ flag: opts.vault, env: process.env.VAULT_MEM_PATH });
      const r = await runReindex({ vault, ftsOnly: opts.ftsOnly, semanticOnly: opts.semanticOnly });
      console.log(`Indexed ${r.count} memories: FTS in ${r.ftsMs}ms, embeddings in ${r.semanticMs}ms`);
    });

  program
    .command("tail-audit")
    .description("Print recent audit lines")
    .option("--vault <path>", "Vault root", undefined)
    .option("-n <count>", "Number of lines", "50")
    .option("--follow", "Follow new lines", false)
    .action(async (opts: { vault?: string; n: string; follow: boolean }) => {
      const vault = resolveVaultPath({ flag: opts.vault, env: process.env.VAULT_MEM_PATH });
      await runTailAudit({ vault, n: parseInt(opts.n, 10), follow: opts.follow });
    });

  program
    .command("export-skill <project>")
    .description("Export a skill bundle for a project (claude|cursor|windsurf|generic)")
    .option("--vault <path>", "Vault root", undefined)
    .option("--target <kind>", "Target runtime: claude|cursor|windsurf|generic", "claude")
    .option("-o, --output <path>", "Output directory (default: ./<project>-skill)")
    .option("--include-inbox", "Include inbox memories (default: canonical only)", false)
    .option("--max-bytes-per-bucket <n>", "Hard cap on body bytes per bucket", "200000")
    .action((project: string, opts: { vault?: string; target: string; output?: string; includeInbox: boolean; maxBytesPerBucket: string }) => {
      const vault = resolveVaultPath({ flag: opts.vault, env: process.env.VAULT_MEM_PATH });
      const r = runExportSkill({
        project,
        vault,
        target: opts.target,
        ...(opts.output !== undefined && { output: opts.output }),
        includeInbox: opts.includeInbox,
        maxBytesPerBucket: parseInt(opts.maxBytesPerBucket, 10),
      });
      console.log(`Exported ${r.stats.total} memories for project '${project}' (target: ${r.target}) → ${r.output}`);
      const breakdown = Object.entries(r.stats.perBucket)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${t}=${n}`)
        .join(" ");
      if (breakdown) console.log(`  buckets: ${breakdown}`);
      console.log(`  files:   ${r.filesWritten.length}`);
      for (const f of r.filesWritten) console.log(`    ${f}`);
    });

  const evalCmd = program
    .command("eval")
    .description("Eval harness for retrieval quality (gold-set Q&A)");

  evalCmd
    .command("run <project>")
    .description("Run every gold set under <vault>/evals/<project>/")
    .option("--vault <path>", "Vault root", undefined)
    .option("--set <name>", "Only run the gold set with this name")
    .option("--top-k <n>", "How many returned items count toward precision (overrides per-question)")
    .option("--max-tokens <n>", "Token budget for memory.context (overrides per-question)")
    .option("--output <path>", "Write JSON report to this path")
    .option("--min-f1 <f>", "Exit non-zero if aggregate F1 < this (0..1)", "0")
    .option(
      "--min-pass-rate <f>",
      "Exit non-zero if pass-rate (% questions with recall=1) < this. Default 0.7 per PRD §8 quality gate.",
      "0.7"
    )
    .action(async (project: string, opts: { vault?: string; set?: string; topK?: string; maxTokens?: string; output?: string; minF1: string; minPassRate: string }) => {
      const vault = resolveVaultPath({ flag: opts.vault, env: process.env.VAULT_MEM_PATH });
      const result = await runEvalCli({
        vault,
        project,
        ...(opts.set !== undefined && { setName: opts.set }),
        ...(opts.topK !== undefined && { topK: parseInt(opts.topK, 10) }),
        ...(opts.maxTokens !== undefined && { maxTokens: parseInt(opts.maxTokens, 10) }),
        ...(opts.output !== undefined && { outputPath: opts.output }),
        minF1: parseFloat(opts.minF1),
        minPassRate: parseFloat(opts.minPassRate),
      });
      if (result.exitCode !== 0) process.exit(result.exitCode);
    });

  program
    .command("serve", { isDefault: true })
    .description("Run the MCP server over stdio (default)")
    .option("--vault <path>", "Vault root", undefined)
    .action(async (opts: { vault?: string }) => {
      const vault = resolveVaultPath({ flag: opts.vault, env: process.env.VAULT_MEM_PATH });
      await runServer(vault);
    });

  await program.parseAsync(argv);
}

main(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
