import { existsSync, statSync } from "node:fs";
import { vaultPaths, MEMORY_TYPES } from "../vault/paths.js";
import { loadConfig } from "../config/index.js";
import { loadSchemas } from "../schema/index.js";
import { openIndex } from "../index/sqlite.js";

export interface DoctorOpts { vault: string }

export interface CheckResult { name: string; pass: boolean; detail?: string }
export interface DoctorResult { ok: boolean; checks: CheckResult[] }

export async function runDoctor(opts: DoctorOpts): Promise<DoctorResult> {
  const checks: CheckResult[] = [];
  const paths = vaultPaths(opts.vault);

  checks.push({
    name: "vault_root",
    pass: existsSync(paths.root) && statSync(paths.root).isDirectory(),
  });

  const folders = [
    paths.systemDir, paths.schemaDir, paths.archiveDir,
    ...MEMORY_TYPES.flatMap((t) => [paths.memoryDir(t), paths.inboxDir(t)]),
  ];
  checks.push({
    name: "folders",
    pass: folders.every((f) => existsSync(f)),
    detail: folders.filter((f) => !existsSync(f)).join(", ") || undefined,
  });

  let schemasOk = true;
  try { loadSchemas(opts.vault); } catch { schemasOk = false; }
  checks.push({ name: "schemas", pass: schemasOk });

  let configOk = true;
  try { loadConfig(opts.vault); } catch (e) {
    configOk = false;
    checks.push({ name: "config", pass: false, detail: (e as Error).message });
  }
  if (configOk) checks.push({ name: "config", pass: true });

  let indexOk = true;
  try {
    const idx = openIndex(paths.indexFile);
    idx.search({ query: "x", limit: 1 });
    idx.close();
  } catch { indexOk = false; }
  checks.push({ name: "index", pass: indexOk });

  checks.push({ name: "audit_log", pass: existsSync(paths.auditFile) });

  return { ok: checks.every((c) => c.pass), checks };
}
