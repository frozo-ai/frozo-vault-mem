import { describe, expect, it } from "vitest";
import { generateId, ID_PATTERN } from "./index.js";

describe("generateId", () => {
  it("matches the documented pattern", () => {
    const id = generateId();
    expect(id).toMatch(ID_PATTERN);
  });

  it("uses the supplied date for the YYYY-MM-DD prefix", () => {
    const id = generateId(new Date("2026-04-27T10:00:00Z"));
    expect(id.startsWith("mem_2026-04-27_")).toBe(true);
  });

  it("produces 6 lowercase hex characters in the suffix", () => {
    const id = generateId();
    const suffix = id.split("_").pop()!;
    expect(suffix).toMatch(/^[0-9a-f]{6}$/);
  });

  it("produces unique IDs over 10k generations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateId());
    expect(seen.size).toBe(10_000);
  });
});

describe("ID_PATTERN", () => {
  it("accepts a known-good id", () => {
    expect(ID_PATTERN.test("mem_2026-04-27_a8f3c0")).toBe(true);
  });
  it("rejects malformed ids", () => {
    expect(ID_PATTERN.test("mem_2026-4-27_a8f3c0")).toBe(false);
    expect(ID_PATTERN.test("mem_2026-04-27_GHIJKL")).toBe(false);
    expect(ID_PATTERN.test("notamem_2026-04-27_a8f3c0")).toBe(false);
  });
});
