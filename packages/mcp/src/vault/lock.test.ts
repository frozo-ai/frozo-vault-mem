import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "./lock.js";

describe("withLock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-lock-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("serializes concurrent calls on the same path", async () => {
    const path = join(dir, "memo.md");
    writeFileSync(path, "init");

    const order: string[] = [];
    const slow = withLock(path, async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("a:end");
    });
    const fast = withLock(path, async () => {
      order.push("b:start");
      order.push("b:end");
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("releases the lock on error", async () => {
    const path = join(dir, "memo.md");
    writeFileSync(path, "init");
    await expect(
      withLock(path, async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
    // A second call must succeed
    await withLock(path, async () => { /* ok */ });
  });
});
