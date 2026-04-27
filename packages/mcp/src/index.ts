import { Command } from "commander";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server/index.js";
import { runInit } from "./cli/init.js";
import { runDoctor } from "./cli/doctor.js";
import { runReindex } from "./cli/reindex.js";
import { runTailAudit } from "./cli/tail-audit.js";
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
    .description("Drop and rebuild the FTS index")
    .option("--vault <path>", "Vault root", undefined)
    .action(async (opts: { vault?: string }) => {
      const vault = resolveVaultPath({ flag: opts.vault, env: process.env.VAULT_MEM_PATH });
      const r = await runReindex({ vault });
      console.log(`Indexed ${r.count} memories in ${r.ms}ms`);
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
