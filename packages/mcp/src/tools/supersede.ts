import { existsSync, readFileSync, renameSync } from "node:fs";
import matter from "gray-matter";
import { atomicWrite } from "../vault/atomicWrite.js";
import { withLock } from "../vault/lock.js";
import { Auditor } from "../audit/index.js";
import { ToolError } from "../errors.js";
import { type IndexHandle } from "../index/sqlite.js";
import type { LanceHandle } from "../index/lance.js";
import {
  vaultPaths, type Location, type MemoryType, MEMORY_TYPES,
} from "../vault/paths.js";

export interface SupersedeToolInput {
  winner_id: string;
  loser_id: string;
  reason?: string;
}

export interface SupersedeToolOutput {
  winner_id: string;
  loser_id: string;
  loser_from: string;
  loser_to: string;
  winner_path: string;
  supersedes_count: number;
  /** True when the supersede was already applied — no files were touched. */
  already_applied: boolean;
}

export interface SupersedeToolDeps {
  vault: string;
  auditor: Auditor;
  index: IndexHandle;
  lance: LanceHandle;
  agent?: string;
  session?: string | null;
}

/**
 * Mark `loser_id` as superseded by `winner_id`:
 *   1. Set loser.status = "superseded" + bump updated.
 *   2. Move loser .md from memory/<bucket>/ to archive/.
 *   3. Append loser_id to winner.supersedes (dedupe).
 *   4. Update FTS + Lance indexes for both rows.
 *   5. Audit log op: "supersede".
 *
 * Idempotent: if loser is already archived with status=superseded AND
 * winner already lists it, returns `already_applied: true` and touches
 * nothing. Refuses to operate on loser memories in inbox/ — promote them
 * first. Refuses self-supersede.
 */
export function createSupersedeTool(deps: SupersedeToolDeps) {
  const paths = vaultPaths(deps.vault);

  type FoundFile = { path: string; type: MemoryType; location: Location };

  function findCanonical(id: string): FoundFile | null {
    for (const t of MEMORY_TYPES) {
      const p = paths.memoryFile(t, id, "memory");
      if (existsSync(p)) return { path: p, type: t, location: "memory" };
    }
    return null;
  }
  function findArchive(id: string): FoundFile | null {
    // archive is flat; we still need the bucket for the index row.
    const p = paths.memoryFile("decision", id, "archive");
    if (!existsSync(p)) return null;
    const { data } = matter(readFileSync(p, "utf8"));
    const t = (data as Record<string, unknown>)["type"];
    if (typeof t !== "string" || !(MEMORY_TYPES as readonly string[]).includes(t)) {
      throw new ToolError(
        "invalid_schema",
        `Archive memory ${id} has unrecognized type=${JSON.stringify(t)}`
      );
    }
    return { path: p, type: t as MemoryType, location: "archive" };
  }
  function findInbox(id: string): FoundFile | null {
    for (const t of MEMORY_TYPES) {
      const p = paths.memoryFile(t, id, "inbox");
      if (existsSync(p)) return { path: p, type: t, location: "inbox" };
    }
    return null;
  }

  function nowIso(): string {
    return new Date().toISOString();
  }

  return {
    async handle(input: SupersedeToolInput): Promise<SupersedeToolOutput> {
      if (!input.winner_id || !input.loser_id) {
        throw new ToolError("schema_validation_failed",
          "Both winner_id and loser_id are required");
      }
      if (input.winner_id === input.loser_id) {
        throw new ToolError("self_supersede",
          `Cannot supersede a memory with itself (${input.winner_id})`);
      }

      // Winner MUST be canonical. We never supersede on behalf of an
      // inbox memory — promote it first.
      const winnerCanonical = findCanonical(input.winner_id);
      if (!winnerCanonical) {
        if (findInbox(input.winner_id)) {
          throw new ToolError("winner_in_inbox",
            `Winner ${input.winner_id} is in inbox/ — promote it first`);
        }
        if (findArchive(input.winner_id)) {
          throw new ToolError("winner_archived",
            `Winner ${input.winner_id} is already archived`);
        }
        throw new ToolError("winner_not_found",
          `No canonical memory with id ${input.winner_id}`);
      }

      // Loser: canonical → normal path; archive + already in winner.supersedes
      // → already applied; anywhere else → error.
      let loserCanonical = findCanonical(input.loser_id);
      const loserArchived = !loserCanonical ? findArchive(input.loser_id) : null;
      if (!loserCanonical && !loserArchived) {
        if (findInbox(input.loser_id)) {
          throw new ToolError("loser_in_inbox",
            `Loser ${input.loser_id} is in inbox/ — promote first or archive directly`);
        }
        throw new ToolError("loser_not_found",
          `No memory with id ${input.loser_id}`);
      }

      // Parse winner frontmatter once to check + later mutate.
      const winnerRaw = readFileSync(winnerCanonical.path, "utf8");
      const winnerParsed = matter(winnerRaw);
      const winnerFm = { ...(winnerParsed.data as Record<string, unknown>) };
      const winnerSupersedes = Array.isArray(winnerFm["supersedes"])
        ? (winnerFm["supersedes"] as unknown[]).filter((x): x is string => typeof x === "string")
        : [];

      const alreadyListed = winnerSupersedes.includes(input.loser_id);

      // Already-applied short-circuit: loser is archived AND winner already
      // lists it. Touching files would just bump timestamps; refuse to.
      if (loserArchived && alreadyListed) {
        return {
          winner_id: input.winner_id,
          loser_id: input.loser_id,
          loser_from: loserArchived.path,
          loser_to: loserArchived.path,
          winner_path: winnerCanonical.path,
          supersedes_count: winnerSupersedes.length,
          already_applied: true,
        };
      }

      // If loser is already archived but winner doesn't list it, we just
      // patch winner. If loser is canonical, we patch both + move file.
      let loserFrom: string;
      let loserTo: string;

      if (loserCanonical) {
        // Step 1: mutate loser frontmatter in place.
        const loserRaw = readFileSync(loserCanonical.path, "utf8");
        const loserParsed = matter(loserRaw);
        const loserFm = { ...(loserParsed.data as Record<string, unknown>) };
        loserFm["status"] = "superseded";
        loserFm["updated"] = nowIso();
        const serialized = matter.stringify(loserParsed.content, loserFm);

        await withLock(loserCanonical.path, async () => {
          atomicWrite(loserCanonical!.path, serialized);
        });

        // Step 2: move to archive/.
        loserFrom = loserCanonical.path;
        loserTo = paths.memoryFile(loserCanonical.type, input.loser_id, "archive");
        await withLock(loserCanonical.path, async () => {
          renameSync(loserFrom, loserTo);
        });

        // Step 3: update FTS index.
        const idxRow = deps.index.getById(input.loser_id);
        if (idxRow) {
          deps.index.upsert({
            ...idxRow,
            status: "superseded",
            location: "archive",
            path: loserTo,
            updated: loserFm["updated"] as string,
          });
        }
        // Step 4: update Lance metadata in place.
        try {
          await deps.lance.updateMetadata(input.loser_id, {
            status: "superseded",
            location: "archive",
            path: loserTo,
            updated: loserFm["updated"] as string,
          });
        } catch {
          // Watcher will reconcile from the rename event.
        }
      } else {
        // Loser already archived from a prior partial run.
        loserFrom = loserArchived!.path;
        loserTo = loserArchived!.path;
      }

      // Step 5: patch winner.supersedes (dedupe) if needed.
      if (!alreadyListed) {
        const newSupersedes = [...winnerSupersedes, input.loser_id];
        winnerFm["supersedes"] = newSupersedes;
        winnerFm["updated"] = nowIso();
        const winnerSerialized = matter.stringify(winnerParsed.content, winnerFm);

        await withLock(winnerCanonical.path, async () => {
          atomicWrite(winnerCanonical.path, winnerSerialized);
        });

        // Update FTS for winner (only updated changes that index cares about).
        const idxWinner = deps.index.getById(input.winner_id);
        if (idxWinner) {
          deps.index.upsert({ ...idxWinner, updated: winnerFm["updated"] as string });
        }
        try {
          await deps.lance.updateMetadata(input.winner_id, {
            updated: winnerFm["updated"] as string,
          });
        } catch { /* watcher will reconcile */ }
      }

      const finalSupersedesCount = alreadyListed
        ? winnerSupersedes.length
        : winnerSupersedes.length + 1;

      deps.auditor.write({
        op: "supersede",
        agent: deps.agent ?? "unknown",
        session: deps.session ?? null,
        winner_id: input.winner_id,
        loser_id: input.loser_id,
        loser_from: loserFrom,
        loser_to: loserTo,
        reason: input.reason,
      });

      return {
        winner_id: input.winner_id,
        loser_id: input.loser_id,
        loser_from: loserFrom,
        loser_to: loserTo,
        winner_path: winnerCanonical.path,
        supersedes_count: finalSupersedesCount,
        already_applied: false,
      };
    },
  };
}
