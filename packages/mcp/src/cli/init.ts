import { cpSync, existsSync, readdirSync, renameSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ulid } from "ulid";
import { vaultPaths } from "../vault/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// From dist/cli/init.js: up 4 levels → repo root → vault-template/
// From src/cli/init.ts (dev): up 4 levels → repo root → vault-template/
const VAULT_TEMPLATE = resolve(__dirname, "../../../../vault-template");

export interface InitOpts {
  target: string;
  git?: boolean;
}

export async function runInit(opts: InitOpts): Promise<{ target: string }> {
  const target = resolve(opts.target);
  if (existsSync(target)) {
    const stat = statSync(target);
    if (!stat.isDirectory()) throw new Error(`Target exists and is not a directory: ${target}`);
    if (readdirSync(target).length > 0) {
      throw new Error(`Refusing to init: target is non-empty: ${target}`);
    }
  }
  cpSync(VAULT_TEMPLATE, target, { recursive: true });

  const paths = vaultPaths(target);
  const examplePath = `${paths.configFile}.example`;
  if (existsSync(examplePath) && !existsSync(paths.configFile)) {
    renameSync(examplePath, paths.configFile);
  }

  // Stamp vault_id
  const cfgRaw = readFileSync(paths.configFile, "utf8");
  if (!/^vault_id:/m.test(cfgRaw)) {
    writeFileSync(paths.configFile, cfgRaw.trimEnd() + `\nvault_id: ${ulid()}\n`);
  }

  // Ensure the audit log file exists (defensive — the empty starter may not
  // have been copied if it was missing from the template due to gitignore
  // rules, see vault-template/.gitignore for context).
  if (!existsSync(paths.auditFile)) {
    writeFileSync(paths.auditFile, "");
  }

  if (opts.git) {
    const { execSync } = await import("node:child_process");
    execSync("git init -q && git add -A && git commit -q -m 'init: scaffold vault-mem'", {
      cwd: target,
      stdio: "ignore",
    });
  }

  return { target };
}
