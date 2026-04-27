import * as BetterSqlite3 from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import type { Location, MemoryType } from "../vault/paths.js";

// Bug 2 fix: NodeNext interop for better-sqlite3 default export
const Database = (BetterSqlite3 as unknown as { default: typeof BetterSqlite3 }).default ?? BetterSqlite3;

const SCHEMA_VERSION = 1;

export interface IndexRow {
  id: string;
  type: MemoryType;
  title: string;
  body: string;
  tags: string[];
  project: string | null;
  status: "active" | "archived" | "superseded";
  location: Location;
  path: string;
  updated: string;
}

export interface SearchInput {
  query: string;
  type?: MemoryType | MemoryType[];
  project?: string;
  status?: "active" | "archived" | "superseded";
  location?: Location | "any";
  limit?: number;
}

export interface SearchResult {
  id: string;
  type: MemoryType;
  title: string;
  snippet: string;
  score: number;
  location: Location;
  path: string;
  project: string | null;
  tags: string[];
  updated: string;
}

export interface IndexHandle {
  upsert(row: IndexRow): void;
  delete(id: string): void;
  getById(id: string): IndexRow | null;
  search(input: SearchInput): { results: SearchResult[]; total: number };
  rebuild(rows: Iterable<IndexRow>): void;
  count(): number;
  close(): void;
}

export function openIndex(filePath: string): IndexHandle {
  const db = new (Database as unknown as new (path: string) => DB)(filePath);
  db.pragma("journal_mode = WAL");
  ensureSchema(db);
  return makeHandle(db);
}

function ensureSchema(db: DB): void {
  const v = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  if (v !== SCHEMA_VERSION) {
    db.exec("DROP TABLE IF EXISTS memories_fts");
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        id UNINDEXED,
        type UNINDEXED,
        title,
        body,
        tags,
        project UNINDEXED,
        status UNINDEXED,
        location UNINDEXED,
        path UNINDEXED,
        updated UNINDEXED,
        tokenize='porter unicode61'
      );
    `);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

function makeHandle(db: DB): IndexHandle {
  const upsert = db.prepare(`
    INSERT INTO memories_fts (id, type, title, body, tags, project, status, location, path, updated)
    VALUES (@id, @type, @title, @body, @tags, @project, @status, @location, @path, @updated)
  `);
  const del = db.prepare("DELETE FROM memories_fts WHERE id = ?");
  const getById = db.prepare(`
    SELECT id, type, title, body, tags, project, status, location, path, updated
    FROM memories_fts WHERE id = ?
  `);

  function rowFromDb(r: Record<string, unknown> | undefined): IndexRow | null {
    if (!r) return null;
    return {
      id: String(r["id"]),
      type: r["type"] as MemoryType,
      title: String(r["title"]),
      body: String(r["body"]),
      // Bug 1 fix: use JSON.parse/stringify for correct tags round-trip
      tags: r["tags"] ? (JSON.parse(String(r["tags"])) as string[]) : [],
      project: r["project"] ? String(r["project"]) : null,
      status: r["status"] as IndexRow["status"],
      location: r["location"] as Location,
      path: String(r["path"]),
      updated: String(r["updated"]),
    };
  }

  return {
    upsert(row) {
      const tx = db.transaction((r: IndexRow) => {
        del.run(r.id);
        upsert.run({
          ...r,
          // Bug 1 fix: use JSON.stringify so tags round-trip correctly
          tags: JSON.stringify(r.tags),
          project: r.project ?? null,
        });
      });
      tx(row);
    },
    delete(id) {
      del.run(id);
    },
    getById(id) {
      return rowFromDb(getById.get(id) as Record<string, unknown> | undefined);
    },
    search(input) {
      const { query } = input;
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
      const types = input.type
        ? Array.isArray(input.type)
          ? input.type
          : [input.type]
        : null;
      const where: string[] = ["memories_fts MATCH @q"];
      const params: Record<string, unknown> = { q: query, limit };

      if (types) {
        where.push(`type IN (${types.map((_, i) => `@t${i}`).join(",")})`);
        types.forEach((t, i) => {
          params[`t${i}`] = t;
        });
      }
      if (input.project) {
        where.push("project = @project");
        params["project"] = input.project;
      }
      if (input.status) {
        where.push("status = @status");
        params["status"] = input.status;
      }
      if (input.location && input.location !== "any") {
        where.push("location = @location");
        params["location"] = input.location;
      }

      const rows = db
        .prepare(
          `
        SELECT id, type, title, project, tags, status, location, path, updated,
               snippet(memories_fts, 3, '<b>', '</b>', '…', 12) AS snippet,
               bm25(memories_fts) AS score
        FROM memories_fts
        WHERE ${where.join(" AND ")}
        ORDER BY score
        LIMIT @limit
      `
        )
        .all(params) as Array<Record<string, unknown>>;

      const totalRow = db
        .prepare(
          `
        SELECT COUNT(*) AS n FROM memories_fts WHERE ${where.join(" AND ")}
      `
        )
        .get(params) as { n: number };

      return {
        results: rows.map((r) => ({
          id: String(r["id"]),
          type: r["type"] as MemoryType,
          title: String(r["title"]),
          snippet: String(r["snippet"] ?? ""),
          score: Number(r["score"]),
          location: r["location"] as Location,
          path: String(r["path"]),
          project: r["project"] ? String(r["project"]) : null,
          // Bug 1 fix: use JSON.parse for tags
          tags: r["tags"] ? (JSON.parse(String(r["tags"])) as string[]) : [],
          updated: String(r["updated"]),
        })),
        total: totalRow.n,
      };
    },
    rebuild(rows) {
      const tx = db.transaction((iter: IndexRow[]) => {
        db.exec("DELETE FROM memories_fts");
        for (const r of iter) {
          upsert.run({
            ...r,
            // Bug 1 fix: use JSON.stringify so tags round-trip correctly
            tags: JSON.stringify(r.tags),
            project: r.project ?? null,
          });
        }
      });
      tx(Array.from(rows));
    },
    count() {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM memories_fts")
        .get() as { n: number };
      return row.n;
    },
    close() {
      db.close();
    },
  };
}
