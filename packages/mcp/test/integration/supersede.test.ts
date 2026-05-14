import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { createWriteTool } from "../../src/tools/write.js";
import { createPromoteTool } from "../../src/tools/promote.js";
import { createSupersedeTool } from "../../src/tools/supersede.js";
import { loadSchemas } from "../../src/schema/index.js";
import { Auditor } from "../../src/audit/index.js";
import { openIndex, type IndexHandle } from "../../src/index/sqlite.js";
import { openLance, type LanceHandle } from "../../src/index/lance.js";
import { createMockEmbedder } from "../../src/embedder/mock.js";
import { vaultPaths, MEMORY_TYPES } from "../../src/vault/paths.js";

interface Harness {
  v: TmpVault;
  idx: IndexHandle;
  lance: LanceHandle;
  auditor: Auditor;
  lanceDir: string;
  writeT: ReturnType<typeof createWriteTool>;
  promoteT: ReturnType<typeof createPromoteTool>;
  supersedeT: ReturnType<typeof createSupersedeTool>;
}

async function setup(v: TmpVault): Promise<Harness> {
  const paths = vaultPaths(v.root);
  for (const t of MEMORY_TYPES) mkdirSync(paths.memoryDir(t), { recursive: true });
  mkdirSync(paths.archiveDir, { recursive: true });
  const schemas = loadSchemas(v.root);
  const idx = openIndex(":memory:");
  const auditor = new Auditor(paths.auditFile);
  const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-supersede-lance-"));
  const lance = await openLance(lanceDir);
  const embedder = createMockEmbedder();
  const writeT = createWriteTool({
    vault: v.root, schemas, auditor, index: idx,
    defaultAgent: "human", lance, embedder,
  });
  const promoteT = createPromoteTool({ vault: v.root, schemas, auditor, index: idx, lance });
  const supersedeT = createSupersedeTool({ vault: v.root, auditor, index: idx, lance, agent: "human" });
  return { v, idx, lance, auditor, lanceDir, writeT, promoteT, supersedeT };
}

async function writeAndPromote(h: Harness, title: string, content = "body"): Promise<string> {
  const w = await h.writeT.handle({
    type: "decision", fields: { title }, content, agent: "human",
  });
  await h.promoteT.handle({ id: w.id });
  return w.id;
}

function readMemoryFile(absPath: string): { fm: Record<string, unknown>; body: string } {
  const parsed = matter(readFileSync(absPath, "utf8"));
  return { fm: parsed.data as Record<string, unknown>, body: parsed.content };
}

describe("memory.supersede", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    return () => v.cleanup();
  });

  it("happy path: archives loser, sets status=superseded, appends to winner.supersedes", async () => {
    const h = await setup(v);
    const paths = vaultPaths(v.root);
    const winner = await writeAndPromote(h, "Use Supabase");
    const loser = await writeAndPromote(h, "Try Auth0");

    const out = await h.supersedeT.handle({ winner_id: winner, loser_id: loser });

    expect(out.already_applied).toBe(false);
    expect(out.supersedes_count).toBe(1);

    // Loser is now in archive/ and removed from memory/decisions/.
    expect(existsSync(paths.memoryFile("decision", loser, "memory"))).toBe(false);
    expect(existsSync(paths.memoryFile("decision", loser, "archive"))).toBe(true);

    const loserNew = readMemoryFile(paths.memoryFile("decision", loser, "archive"));
    expect(loserNew.fm["status"]).toBe("superseded");
    expect(loserNew.fm["id"]).toBe(loser);

    // Winner frontmatter now lists loser.
    const winnerNew = readMemoryFile(paths.memoryFile("decision", winner, "memory"));
    expect(winnerNew.fm["supersedes"]).toEqual([loser]);

    // Index reflects new locations.
    expect(h.idx.getById(loser)?.location).toBe("archive");
    expect(h.idx.getById(loser)?.status).toBe("superseded");

    rmSync(h.lanceDir, { recursive: true, force: true });
  });

  it("idempotent: second call returns already_applied=true and touches nothing", async () => {
    const h = await setup(v);
    const paths = vaultPaths(v.root);
    const winner = await writeAndPromote(h, "W");
    const loser = await writeAndPromote(h, "L");

    const first = await h.supersedeT.handle({ winner_id: winner, loser_id: loser });
    const archived = paths.memoryFile("decision", loser, "archive");
    const tsBefore = readMemoryFile(archived).fm["updated"];
    const winnerTsBefore = readMemoryFile(paths.memoryFile("decision", winner, "memory")).fm["updated"];

    // Sleep enough that any rewrite would change the `updated` timestamp.
    await new Promise((r) => setTimeout(r, 10));

    const second = await h.supersedeT.handle({ winner_id: winner, loser_id: loser });
    expect(first.already_applied).toBe(false);
    expect(second.already_applied).toBe(true);

    // Files were NOT rewritten the second time.
    expect(readMemoryFile(archived).fm["updated"]).toBe(tsBefore);
    expect(readMemoryFile(paths.memoryFile("decision", winner, "memory")).fm["updated"])
      .toBe(winnerTsBefore);

    rmSync(h.lanceDir, { recursive: true, force: true });
  });

  it("rejects self-supersede", async () => {
    const h = await setup(v);
    const id = await writeAndPromote(h, "alone");
    await expect(h.supersedeT.handle({ winner_id: id, loser_id: id }))
      .rejects.toMatchObject({ kind: "self_supersede" });
    rmSync(h.lanceDir, { recursive: true, force: true });
  });

  it("rejects unknown winner", async () => {
    const h = await setup(v);
    const loser = await writeAndPromote(h, "L");
    await expect(h.supersedeT.handle({
      winner_id: "mem_2026-05-14_aaaaaa",
      loser_id: loser,
    })).rejects.toMatchObject({ kind: "winner_not_found" });
    rmSync(h.lanceDir, { recursive: true, force: true });
  });

  it("rejects unknown loser", async () => {
    const h = await setup(v);
    const winner = await writeAndPromote(h, "W");
    await expect(h.supersedeT.handle({
      winner_id: winner,
      loser_id: "mem_2026-05-14_bbbbbb",
    })).rejects.toMatchObject({ kind: "loser_not_found" });
    rmSync(h.lanceDir, { recursive: true, force: true });
  });

  it("rejects when loser is still in inbox", async () => {
    const h = await setup(v);
    const winner = await writeAndPromote(h, "W");
    // Write a loser but do NOT promote
    const w = await h.writeT.handle({
      type: "decision", fields: { title: "still inbox" }, content: "x", agent: "human",
    });
    await expect(h.supersedeT.handle({ winner_id: winner, loser_id: w.id }))
      .rejects.toMatchObject({ kind: "loser_in_inbox" });
    rmSync(h.lanceDir, { recursive: true, force: true });
  });

  it("rejects when winner is in inbox", async () => {
    const h = await setup(v);
    const loser = await writeAndPromote(h, "L");
    const w = await h.writeT.handle({
      type: "decision", fields: { title: "winner inbox" }, content: "x", agent: "human",
    });
    await expect(h.supersedeT.handle({ winner_id: w.id, loser_id: loser }))
      .rejects.toMatchObject({ kind: "winner_in_inbox" });
    rmSync(h.lanceDir, { recursive: true, force: true });
  });

  it("rejects when winner is already archived", async () => {
    const h = await setup(v);
    const paths = vaultPaths(v.root);
    const winner = await writeAndPromote(h, "W");
    const loser = await writeAndPromote(h, "L");
    // Manually move winner to archive to simulate a prior op
    renameSync(
      paths.memoryFile("decision", winner, "memory"),
      paths.memoryFile("decision", winner, "archive"),
    );
    await expect(h.supersedeT.handle({ winner_id: winner, loser_id: loser }))
      .rejects.toMatchObject({ kind: "winner_archived" });
    rmSync(h.lanceDir, { recursive: true, force: true });
  });

  it("recovers from partial state: loser already archived but winner doesn't list it → patches winner", async () => {
    const h = await setup(v);
    const paths = vaultPaths(v.root);
    const winner = await writeAndPromote(h, "W");
    const loser = await writeAndPromote(h, "L");

    // Simulate a crash where loser got archived but winner-update never ran.
    // (1) Mutate loser frontmatter to status=superseded, (2) move to archive.
    const loserPath = paths.memoryFile("decision", loser, "memory");
    const parsed = matter(readFileSync(loserPath, "utf8"));
    const fm = { ...(parsed.data as Record<string, unknown>), status: "superseded" };
    writeFileSync(loserPath, matter.stringify(parsed.content, fm));
    renameSync(loserPath, paths.memoryFile("decision", loser, "archive"));

    const out = await h.supersedeT.handle({ winner_id: winner, loser_id: loser });
    expect(out.already_applied).toBe(false);
    expect(out.supersedes_count).toBe(1);

    const winnerNew = readMemoryFile(paths.memoryFile("decision", winner, "memory"));
    expect(winnerNew.fm["supersedes"]).toEqual([loser]);
    rmSync(h.lanceDir, { recursive: true, force: true });
  });

  it("accumulates: winner.supersedes grows when more losers come in", async () => {
    const h = await setup(v);
    const paths = vaultPaths(v.root);
    const winner = await writeAndPromote(h, "W");
    const l1 = await writeAndPromote(h, "L1");
    const l2 = await writeAndPromote(h, "L2");

    await h.supersedeT.handle({ winner_id: winner, loser_id: l1 });
    const out2 = await h.supersedeT.handle({ winner_id: winner, loser_id: l2 });
    expect(out2.supersedes_count).toBe(2);

    const wfm = readMemoryFile(paths.memoryFile("decision", winner, "memory")).fm;
    expect(wfm["supersedes"]).toEqual([l1, l2]);
    rmSync(h.lanceDir, { recursive: true, force: true });
  });

  it("audits op: supersede with winner_id, loser_id, paths", async () => {
    const h = await setup(v);
    const paths = vaultPaths(v.root);
    const winner = await writeAndPromote(h, "W");
    const loser = await writeAndPromote(h, "L");

    await h.supersedeT.handle({ winner_id: winner, loser_id: loser, reason: "manual" });

    const audit = readFileSync(paths.auditFile, "utf8").trim().split("\n");
    const last = JSON.parse(audit[audit.length - 1]!);
    expect(last.op).toBe("supersede");
    expect(last.winner_id).toBe(winner);
    expect(last.loser_id).toBe(loser);
    expect(last.reason).toBe("manual");
    expect(last.loser_to).toBe(paths.memoryFile("decision", loser, "archive"));
    rmSync(h.lanceDir, { recursive: true, force: true });
  });

  it("updates Lance metadata (loser.location → archive, status → superseded)", async () => {
    const h = await setup(v);
    const winner = await writeAndPromote(h, "W");
    const loser = await writeAndPromote(h, "L");

    expect((await h.lance.getById(loser))?.location).toBe("memory");

    await h.supersedeT.handle({ winner_id: winner, loser_id: loser });

    const after = await h.lance.getById(loser);
    expect(after?.location).toBe("archive");
    expect(after?.status).toBe("superseded");
    rmSync(h.lanceDir, { recursive: true, force: true });
  });

  it("dedupes loser_id in winner.supersedes when winner already had it (idempotent file state)", async () => {
    const h = await setup(v);
    const paths = vaultPaths(v.root);
    const winner = await writeAndPromote(h, "W");
    const loser = await writeAndPromote(h, "L");

    // Pre-seed winner with loser already in its supersedes list.
    const winnerPath = paths.memoryFile("decision", winner, "memory");
    const parsed = matter(readFileSync(winnerPath, "utf8"));
    const fm = { ...(parsed.data as Record<string, unknown>), supersedes: [loser] };
    writeFileSync(winnerPath, matter.stringify(parsed.content, fm));

    const out = await h.supersedeT.handle({ winner_id: winner, loser_id: loser });
    // loser is still canonical → not already_applied (we DO archive it),
    // but winner.supersedes already lists it so we don't re-append.
    expect(out.already_applied).toBe(false);
    const wfmAfter = readMemoryFile(winnerPath).fm;
    expect(wfmAfter["supersedes"]).toEqual([loser]);
    expect(out.supersedes_count).toBe(1);

    rmSync(h.lanceDir, { recursive: true, force: true });
  });
});
