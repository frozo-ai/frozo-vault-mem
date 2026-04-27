import { readFileSync } from "node:fs";
import { parse } from "yaml";
import Ajv from "ajv";
import { vaultPaths } from "../vault/paths.js";

export interface VaultConfig {
  vault_version: string;
  schema_version: string;
  default_agent: string;
  inbox_routing: "always";
  fts: { index_path: string; rebuild_on_startup: boolean };
  audit: { log_path: string };
  vault_id?: string;
}

const CONFIG_SCHEMA = {
  type: "object",
  required: ["vault_version", "schema_version", "default_agent", "inbox_routing", "fts", "audit"],
  properties: {
    vault_version: { type: ["string", "number"] },
    schema_version: { type: ["string", "number"] },
    default_agent: { type: "string", minLength: 1 },
    inbox_routing: { type: "string", enum: ["always"] },
    fts: {
      type: "object",
      required: ["index_path", "rebuild_on_startup"],
      properties: {
        index_path: { type: "string", minLength: 1 },
        rebuild_on_startup: { type: "boolean" },
      },
    },
    audit: {
      type: "object",
      required: ["log_path"],
      properties: { log_path: { type: "string", minLength: 1 } },
    },
    vault_id: { type: "string" },
  },
} as const;

export function loadConfig(vaultRoot: string): VaultConfig {
  const paths = vaultPaths(vaultRoot);
  let raw: string;
  try {
    raw = readFileSync(paths.configFile, "utf8");
  } catch {
    throw new Error(`Missing config.yaml at ${paths.configFile}`);
  }
  const parsed = parse(raw);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(CONFIG_SCHEMA as object);
  if (!validate(parsed)) {
    throw new Error(
      `Invalid config.yaml: ${ajv.errorsText(validate.errors)}`,
    );
  }
  const cfg = parsed as VaultConfig;
  return {
    ...cfg,
    vault_version: String(cfg.vault_version),
    schema_version: String(cfg.schema_version),
  };
}
