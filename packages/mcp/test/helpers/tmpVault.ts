import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VAULT_TEMPLATE = resolve(__dirname, "../../../../vault-template");

export interface TmpVault {
  root: string;
  cleanup: () => void;
}

export function makeTmpVault(): TmpVault {
  const root = mkdtempSync(join(tmpdir(), "vault-mem-test-"));
  cpSync(VAULT_TEMPLATE, root, { recursive: true });
  // Materialize config from example
  const cfg = [
    "vault_version: 0.1",
    "schema_version: 0.1",
    "default_agent: human",
    "inbox_routing: always",
    "fts:",
    "  index_path: _system/index.sqlite",
    "  rebuild_on_startup: false",
    "audit:",
    "  log_path: _system/audit.log",
  ].join("\n");
  writeFileSync(join(root, "_system/config.yaml"), cfg);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
