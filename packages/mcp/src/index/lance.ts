import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import { mkdirSync } from "node:fs";
import type { Location, MemoryType } from "../vault/paths.js";
import { EMBED_DIM, EMBED_MODEL_ID } from "../embedder/index.js";

const TABLE_NAME = "memories";

export interface LanceRow {
  id: string;
  vector: Float32Array;
  type: MemoryType;
  title: string;
  project: string | null;
  tags: string[];
  status: "active" | "archived" | "superseded";
  location: Location;
  path: string;
  updated: string;
  schema_version: string;
  embed_model: string;
}

export interface LanceFilter {
  type?: MemoryType | MemoryType[];
  project?: string;
  status?: "active" | "archived" | "superseded";
  location?: Location | "any";
}

export interface LanceSearchResult {
  id: string;
  type: MemoryType;
  title: string;
  project: string | null;
  tags: string[];
  status: "active" | "archived" | "superseded";
  location: Location;
  path: string;
  updated: string;
  score: number;
}

export interface LanceHandle {
  upsert(row: LanceRow): Promise<void>;
  delete(id: string): Promise<void>;
  getById(id: string): Promise<LanceRow | null>;
  search(qvec: Float32Array, filter: LanceFilter, limit: number): Promise<{ results: LanceSearchResult[]; total: number }>;
  rebuild(rows: Iterable<LanceRow>): Promise<void>;
  updateMetadata(id: string, fields: Partial<Pick<LanceRow, "location" | "path" | "status" | "updated">>): Promise<void>;
  count(): Promise<number>;
  close(): Promise<void>;
}

function escape(s: string): string {
  return s.replace(/'/g, "''");
}

function buildWhere(filter: LanceFilter): string | null {
  const parts: string[] = [];
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    parts.push(`type IN (${types.map((t) => `'${escape(t)}'`).join(", ")})`);
  }
  if (filter.project) parts.push(`project = '${escape(filter.project)}'`);
  if (filter.status) parts.push(`status = '${escape(filter.status)}'`);
  if (filter.location && filter.location !== "any") parts.push(`location = '${escape(filter.location)}'`);
  return parts.length > 0 ? parts.join(" AND ") : null;
}

function rowToInput(row: LanceRow): Record<string, unknown> {
  return {
    id: row.id,
    vector: Array.from(row.vector),
    type: row.type,
    title: row.title,
    project: row.project,
    tags: row.tags,
    status: row.status,
    location: row.location,
    path: row.path,
    updated: row.updated,
    schema_version: row.schema_version,
    embed_model: row.embed_model,
  };
}

function rowFromDb(r: Record<string, unknown> | undefined | null): LanceRow | null {
  if (!r) return null;
  const rawVec = r["vector"] as ArrayLike<number> | Float32Array | undefined;
  return {
    id: String(r["id"]),
    vector: rawVec ? new Float32Array(Array.from(rawVec)) : new Float32Array(EMBED_DIM),
    type: r["type"] as MemoryType,
    title: String(r["title"]),
    project: r["project"] != null ? String(r["project"]) : null,
    tags: Array.isArray(r["tags"]) ? (r["tags"] as unknown[]).map((x) => String(x)) : [],
    status: r["status"] as LanceRow["status"],
    location: r["location"] as Location,
    path: String(r["path"]),
    updated: String(r["updated"]),
    schema_version: String(r["schema_version"]),
    embed_model: String(r["embed_model"]),
  };
}

export async function openLance(dir: string): Promise<LanceHandle> {
  mkdirSync(dir, { recursive: true });
  const db: Connection = await lancedb.connect(dir);
  let table: Table;
  const existing = await db.tableNames();
  if (existing.includes(TABLE_NAME)) {
    table = await db.openTable(TABLE_NAME);
  } else {
    // Create with one seed row, then immediately delete it, so the schema
    // (vector dimension etc.) is locked in. LanceDB infers schema from data.
    // Use a non-null placeholder so LanceDB can infer column types correctly.
    // The seed row is deleted immediately after table creation.
    const seed = rowToInput({
      id: "__seed__",
      vector: new Float32Array(EMBED_DIM),
      type: "decision",
      title: "__seed__",
      project: "__seed__",
      tags: ["__seed__"],
      status: "active",
      location: "inbox",
      path: "__seed__",
      updated: "__seed__",
      schema_version: "0.1",
      embed_model: EMBED_MODEL_ID,
    });
    table = await db.createTable(TABLE_NAME, [seed]);
    await table.delete("id = '__seed__'");
  }

  async function upsert(row: LanceRow): Promise<void> {
    // Lance has no native upsert; emulate via delete-then-add.
    await table.delete(`id = '${escape(row.id)}'`);
    await table.add([rowToInput(row)]);
  }

  async function deleteRow(id: string): Promise<void> {
    await table.delete(`id = '${escape(id)}'`);
  }

  async function getById(id: string): Promise<LanceRow | null> {
    const rows = await table
      .query()
      .where(`id = '${escape(id)}'`)
      .limit(1)
      .toArray();
    return rowFromDb(rows[0]);
  }

  async function search(qvec: Float32Array, filter: LanceFilter, limit: number): Promise<{ results: LanceSearchResult[]; total: number }> {
    const where = buildWhere(filter);
    let q = (table.search(Array.from(qvec)) as ReturnType<Table["search"]>).limit(limit);
    if (where) q = q.where(where);
    const results = (await q.toArray()) as Array<Record<string, unknown>>;
    const mapped: LanceSearchResult[] = results.map((r) => ({
      id: String(r["id"]),
      type: r["type"] as MemoryType,
      title: String(r["title"]),
      project: r["project"] != null ? String(r["project"]) : null,
      tags: Array.isArray(r["tags"]) ? (r["tags"] as unknown[]).map((x) => String(x)) : [],
      status: r["status"] as LanceSearchResult["status"],
      location: r["location"] as Location,
      path: String(r["path"]),
      updated: String(r["updated"]),
      score: Number(r["_distance"] ?? 0),
    }));
    // Total: reuse count of filtered rows
    const totalQ = await table
      .query()
      .where(where ?? "true")
      .toArray();
    return { results: mapped, total: totalQ.length };
  }

  async function rebuild(rows: Iterable<LanceRow>): Promise<void> {
    // Drop all, re-add. Schema preserved via the existing table.
    await table.delete("true");
    const arr = Array.from(rows).map(rowToInput);
    if (arr.length > 0) await table.add(arr);
  }

  async function updateMetadata(id: string, fields: Partial<Pick<LanceRow, "location" | "path" | "status" | "updated">>): Promise<void> {
    // No partial-update API; emulate via getById + upsert with same vector.
    const existing = await getById(id);
    if (!existing) return;
    const updated: LanceRow = { ...existing, ...fields };
    await upsert(updated);
  }

  async function count(): Promise<number> {
    return table.countRows();
  }

  async function close(): Promise<void> {
    // Connection is closed by GC; nothing to do explicitly in current API.
  }

  return {
    upsert,
    delete: deleteRow,
    getById,
    search,
    rebuild,
    updateMetadata,
    count,
    close,
  };
}
