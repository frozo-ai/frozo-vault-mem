import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./index.js";

describe("loadConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-cfg-"));
    mkdirSync(join(dir, "_system"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("loads a valid config", () => {
    writeFileSync(
      join(dir, "_system/config.yaml"),
      [
        "vault_version: 0.1",
        "schema_version: 0.1",
        "default_agent: human",
        "inbox_routing: always",
        "fts:",
        "  index_path: _system/index.sqlite",
        "  rebuild_on_startup: false",
        "audit:",
        "  log_path: _system/audit.log",
      ].join("\n"),
    );
    const cfg = loadConfig(dir);
    expect(cfg.default_agent).toBe("human");
    expect(cfg.inbox_routing).toBe("always");
    expect(cfg.fts.rebuild_on_startup).toBe(false);
  });

  it("throws when config.yaml is missing", () => {
    expect(() => loadConfig(dir)).toThrow(/config\.yaml/);
  });

  it("throws when required fields are missing", () => {
    writeFileSync(join(dir, "_system/config.yaml"), "vault_version: 0.1\n");
    expect(() => loadConfig(dir)).toThrow();
  });
});
