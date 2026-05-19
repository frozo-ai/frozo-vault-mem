import { describe, expect, it } from "vitest";
import { openIndex, type IndexRow } from "./sqlite.js";

const sample = (over: Partial<IndexRow> = {}): IndexRow => ({
  id: "mem_2026-04-27_aaaaaa",
  type: "decision",
  title: "Use Supabase for auth",
  body: "Supabase has DPDP-compatible hosting and RLS.",
  tags: ["myapp", "auth"],
  project: "myapp",
  status: "active",
  location: "memory",
  path: "/v/memory/decisions/mem_2026-04-27_aaaaaa.md",
  updated: "2026-04-27T14:32:00.000Z",
  ...over,
});

describe("openIndex (in-memory)", () => {
  it("creates the FTS schema and round-trips an upsert + lookup", () => {
    const idx = openIndex(":memory:");
    idx.upsert(sample());
    const row = idx.getById("mem_2026-04-27_aaaaaa");
    expect(row?.title).toBe("Use Supabase for auth");
    expect(row?.location).toBe("memory");
    expect(row?.tags).toEqual(["myapp", "auth"]);
  });

  it("returns [] for tags when the column is corrupt or missing", () => {
    const idx = openIndex(":memory:");
    idx.upsert(sample({ tags: [] }));
    const row = idx.getById("mem_2026-04-27_aaaaaa");
    expect(row?.tags).toEqual([]);
  });

  it("search matches title and body, ranks by BM25", () => {
    const idx = openIndex(":memory:");
    idx.upsert(sample({ id: "mem_2026-04-27_aaaaaa", title: "Use Supabase for auth", body: "supabase rls" }));
    idx.upsert(sample({ id: "mem_2026-04-27_bbbbbb", title: "Pricing", body: "supabase free tier" }));
    idx.upsert(sample({ id: "mem_2026-04-27_cccccc", title: "Other", body: "unrelated" }));

    const r = idx.search({ query: "supabase", limit: 10 });
    expect(r.results.map((x) => x.id).sort()).toEqual([
      "mem_2026-04-27_aaaaaa", "mem_2026-04-27_bbbbbb",
    ]);
  });

  it("filters by type, project, status, location", () => {
    const idx = openIndex(":memory:");
    idx.upsert(sample({ id: "mem_2026-04-27_aaaaaa", type: "decision", project: "myapp" }));
    idx.upsert(sample({ id: "mem_2026-04-27_bbbbbb", type: "observation", project: "myapp" }));
    idx.upsert(sample({ id: "mem_2026-04-27_cccccc", type: "decision", project: "otherapp" }));

    expect(idx.search({ query: "supabase", type: "decision", limit: 10 }).results).toHaveLength(2);
    expect(idx.search({ query: "supabase", project: "myapp", limit: 10 }).results).toHaveLength(2);
    expect(idx.search({ query: "supabase", type: "decision", project: "myapp", limit: 10 }).results).toHaveLength(1);
  });

  it("delete removes a row", () => {
    const idx = openIndex(":memory:");
    idx.upsert(sample());
    idx.delete("mem_2026-04-27_aaaaaa");
    expect(idx.getById("mem_2026-04-27_aaaaaa")).toBeNull();
  });

  it("list returns all rows matching filters without MATCH", () => {
    const idx = openIndex(":memory:");
    idx.upsert(sample({ id: "mem_2026-04-27_aaaaaa", type: "decision", project: "myapp" }));
    idx.upsert(sample({ id: "mem_2026-04-27_bbbbbb", type: "observation", project: "myapp" }));
    idx.upsert(sample({ id: "mem_2026-04-27_cccccc", type: "decision", project: "otherapp" }));

    expect(idx.list({}).length).toBe(3);
    expect(idx.list({ type: "decision" }).length).toBe(2);
    expect(idx.list({ project: "myapp" }).length).toBe(2);
    expect(idx.list({ type: "decision", project: "myapp" }).length).toBe(1);
  });

  // ---- DPDP erasure: status='erased' is filtered by default ----------------

  it("search hides status='erased' rows by default", () => {
    const idx = openIndex(":memory:");
    idx.upsert(sample({ id: "mem_2026-04-27_aaaaaa", body: "supabase active row" }));
    idx.upsert(sample({
      id: "mem_2026-04-27_eeeeee",
      body: "supabase erased stub",
      status: "erased",
      location: "archive",
    }));
    const r = idx.search({ query: "supabase", limit: 10 });
    expect(r.results.map((x) => x.id)).toEqual(["mem_2026-04-27_aaaaaa"]);
  });

  it("search returns status='erased' rows when explicitly asked", () => {
    const idx = openIndex(":memory:");
    idx.upsert(sample({ id: "mem_2026-04-27_aaaaaa", body: "supabase active" }));
    idx.upsert(sample({
      id: "mem_2026-04-27_eeeeee",
      body: "supabase erased",
      status: "erased",
      location: "archive",
    }));
    const r = idx.search({ query: "supabase", status: "erased", limit: 10 });
    expect(r.results.map((x) => x.id)).toEqual(["mem_2026-04-27_eeeeee"]);
  });

  it("list also hides status='erased' rows by default", () => {
    const idx = openIndex(":memory:");
    idx.upsert(sample({ id: "mem_2026-04-27_aaaaaa" }));
    idx.upsert(sample({
      id: "mem_2026-04-27_eeeeee",
      status: "erased",
      location: "archive",
    }));
    expect(idx.list({}).map((r) => r.id)).toEqual(["mem_2026-04-27_aaaaaa"]);
    expect(idx.list({ status: "erased" }).map((r) => r.id)).toEqual([
      "mem_2026-04-27_eeeeee",
    ]);
  });

  it("default-filter doesn't suppress archived or superseded rows", () => {
    // Only status='erased' is hidden by default; archived + superseded
    // remain visible (existing behavior — those are reachable memories).
    const idx = openIndex(":memory:");
    idx.upsert(sample({ id: "mem_2026-04-27_aaaaaa", body: "x" }));
    idx.upsert(sample({ id: "mem_2026-04-27_bbbbbb", body: "x", status: "archived", location: "archive" }));
    idx.upsert(sample({ id: "mem_2026-04-27_cccccc", body: "x", status: "superseded" }));
    idx.upsert(sample({ id: "mem_2026-04-27_eeeeee", body: "x", status: "erased", location: "archive" }));
    const r = idx.search({ query: "x", limit: 10 });
    expect(r.results.map((x) => x.id).sort()).toEqual([
      "mem_2026-04-27_aaaaaa",
      "mem_2026-04-27_bbbbbb",
      "mem_2026-04-27_cccccc",
    ]);
  });
});
