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

  it("serializes concurrent calls on the same path (no interleaving)", async () => {
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

    // proper-lockfile does not guarantee FIFO ordering — only mutual exclusion.
    // Assert: each task's start precedes its end, and the two tasks don't interleave.
    const aStart = order.indexOf("a:start");
    const aEnd   = order.indexOf("a:end");
    const bStart = order.indexOf("b:start");
    const bEnd   = order.indexOf("b:end");
    expect(aStart).toBeGreaterThanOrEqual(0);
    expect(bStart).toBeGreaterThanOrEqual(0);
    expect(aStart).toBeLessThan(aEnd);
    expect(bStart).toBeLessThan(bEnd);
    // Non-interleaving: either all a-events come before all b-events, or vice versa.
    const aMax = Math.max(aStart, aEnd);
    const aMin = Math.min(aStart, aEnd);
    const bMax = Math.max(bStart, bEnd);
    const bMin = Math.min(bStart, bEnd);
    expect(aMax < bMin || bMax < aMin).toBe(true);
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
