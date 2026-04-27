import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./atomicWrite.js";

describe("atomicWrite", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-aw-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("writes content atomically and leaves no temp files behind", () => {
    const path = join(dir, "memo.md");
    atomicWrite(path, "hello world");
    expect(readFileSync(path, "utf8")).toBe("hello world");
    const leftover = readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(leftover).toHaveLength(0);
  });

  it("overwrites existing content cleanly", () => {
    const path = join(dir, "memo.md");
    atomicWrite(path, "first");
    atomicWrite(path, "second");
    expect(readFileSync(path, "utf8")).toBe("second");
  });

  it("supports unicode content", () => {
    const path = join(dir, "memo.md");
    atomicWrite(path, "😀 नमस्ते 你好");
    expect(readFileSync(path, "utf8")).toBe("😀 नमस्ते 你好");
  });
});
