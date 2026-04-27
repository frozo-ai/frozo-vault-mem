import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { vaultPaths, MEMORY_TYPES } from "../vault/paths.js";
import { loadConfig, resolveConfigPaths } from "../config/index.js";
import { loadSchemas } from "../schema/index.js";
import { openIndex } from "../index/sqlite.js";
import { openLance } from "../index/lance.js";

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
  let resolvedIndexPath = paths.indexFile;
  let resolvedAuditPath = paths.auditFile;
  try {
    const cfg = loadConfig(opts.vault);
    const resolved = resolveConfigPaths(opts.vault, cfg);
    resolvedIndexPath = resolved.resolvedIndexPath;
    resolvedAuditPath = resolved.resolvedAuditPath;
  } catch (e) {
    configOk = false;
    checks.push({ name: "config", pass: false, detail: (e as Error).message });
  }
  if (configOk) checks.push({ name: "config", pass: true });

  let indexOk = true;
  try {
    const idx = openIndex(resolvedIndexPath);
    idx.search({ query: "x", limit: 1 });
    idx.close();
  } catch { indexOk = false; }
  checks.push({ name: "index", pass: indexOk });

  // Check row-count match between on-disk files and index
  let rowCountOk = true;
  let rowCountDetail: string | undefined;
  try {
    const idx = openIndex(resolvedIndexPath);
    const indexCount = idx.count();
    let diskCount = 0;
    for (const t of MEMORY_TYPES) {
      const memDir = paths.memoryDir(t);
      const inboxDir = paths.inboxDir(t);
      try {
        const { readdirSync } = await import("node:fs");
        diskCount += readdirSync(memDir).filter((f) => f.endsWith(".md")).length;
        diskCount += readdirSync(inboxDir).filter((f) => f.endsWith(".md")).length;
      } catch { /* missing dir handled by folders check */ }
    }
    try {
      const { readdirSync } = await import("node:fs");
      diskCount += readdirSync(paths.archiveDir).filter((f) => f.endsWith(".md")).length;
    } catch { /* missing dir handled by folders check */ }
    idx.close();
    if (indexCount > 0 && indexCount !== diskCount) {
      rowCountOk = false;
      rowCountDetail = `index has ${indexCount} rows, disk has ${diskCount} .md files (run 'reindex' to reconcile)`;
    }
  } catch (e) {
    rowCountOk = false;
    rowCountDetail = (e as Error).message;
  }
  checks.push({ name: "row_count_match", pass: rowCountOk, detail: rowCountDetail });

  let auditOk = false;
  let auditDetail: string | undefined;
  try {
    const { accessSync, constants } = await import("node:fs");
    accessSync(resolvedAuditPath, constants.W_OK);
    auditOk = true;
  } catch (e) {
    auditDetail = `${resolvedAuditPath}: ${(e as Error).message}`;
  }
  checks.push({ name: "audit_log", pass: auditOk, detail: auditDetail });

  // Check embeddings index (Lance). Missing dir = 0 rows = pass (not yet populated).
  let lanceCount = 0;
  let embeddingsOk = true;
  let embeddingsDetail: string | undefined;
  try {
    const lanceDir = join(paths.systemDir, "embeddings.lance");
    if (existsSync(lanceDir)) {
      const lance = await openLance(lanceDir);
      lanceCount = await lance.count();
      await lance.close();
    }
    // If dir doesn't exist, lanceCount stays 0; that's fine (pass with 0 count).
  } catch (e) {
    embeddingsOk = false;
    embeddingsDetail = (e as Error).message;
  }
  checks.push({ name: "embeddings_index", pass: embeddingsOk, detail: embeddingsDetail });

  // Check count match between FTS index and Lance index.
  // Skipped (passes) when either count is 0 — handles freshly-init or not-yet-populated vaults.
  let countMatchOk = true;
  let countMatchDetail: string | undefined;
  try {
    const idx2 = openIndex(resolvedIndexPath);
    const ftsCount = idx2.count();
    idx2.close();
    if (ftsCount > 0 && lanceCount > 0 && ftsCount !== lanceCount) {
      countMatchOk = false;
      countMatchDetail = `FTS has ${ftsCount} rows, Lance has ${lanceCount} rows (run 'reindex' to reconcile)`;
    }
  } catch (e) {
    countMatchOk = false;
    countMatchDetail = (e as Error).message;
  }
  checks.push({ name: "embeddings_count_match", pass: countMatchOk, detail: countMatchDetail });

  return { ok: checks.every((c) => c.pass), checks };
}
