import type { BundledMemory, SkillBundle } from "./types.js";

/**
 * Shared markdown rendering helpers — used by all target writers so the
 * memory-body presentation is consistent across claude / cursor /
 * windsurf / generic.
 */

const BUCKET_LABEL: Record<keyof BucketSections, string> = {
  decisions: "Decision",
  learnings: "Learning",
  observations: "Observation",
  todos: "Todo",
  entities: "Entity",
  questions: "Question",
  summaries: "Summary",
};

type BucketSections = Pick<
  SkillBundle,
  "decisions" | "learnings" | "observations" | "todos" | "entities" | "questions" | "summaries"
>;

const BUCKET_ORDER: Array<keyof BucketSections> = [
  "summaries",
  "decisions",
  "learnings",
  "observations",
  "entities",
  "questions",
  "todos",
];

export function renderMemoryAsMarkdown(m: BundledMemory, headingLevel: 2 | 3 = 2): string {
  const h = "#".repeat(headingLevel);
  const date = m.created.slice(0, 10);
  const titleLine = `${h} ${date} — ${m.title}`;
  const metaParts: string[] = [`**id**: \`${m.id}\``, `**confidence**: ${m.confidence.toFixed(2)}`];
  if (m.agent) metaParts.push(`**agent**: ${m.agent}`);
  if (m.tags.length > 0) metaParts.push(`**tags**: ${m.tags.map((t) => `\`${t}\``).join(", ")}`);
  const meta = metaParts.join(" · ");
  const body = m.body.trim();
  return `${titleLine}\n\n${meta}\n\n${body}\n`;
}

/**
 * Render one bucket section ("# Decisions" / "# Learnings" / …).
 * Returns empty string when the bucket has no entries — caller decides
 * whether to include a header at all.
 */
export function renderBucketSection(
  bucketKey: keyof BucketSections,
  bucket: BundledMemory[]
): string {
  if (bucket.length === 0) return "";
  const label = BUCKET_LABEL[bucketKey];
  const plural = bucketKey.charAt(0).toUpperCase() + bucketKey.slice(1);
  const heading = `# ${plural} (${bucket.length} ${bucket.length === 1 ? label.toLowerCase() : label.toLowerCase() + "s"})\n`;
  const items = bucket.map((m) => renderMemoryAsMarkdown(m, 2)).join("\n---\n\n");
  return `${heading}\n${items}`;
}

/**
 * Render the full project body — every bucket concatenated in the same
 * order the OSS context bundler uses. Suitable for single-file targets
 * (cursor, windsurf).
 */
export function renderFullProjectBody(bundle: SkillBundle): string {
  const sections: string[] = [];
  for (const key of BUCKET_ORDER) {
    const section = renderBucketSection(key, bundle[key]);
    if (section) sections.push(section);
  }
  if (sections.length === 0) {
    return "_(no memories yet for this project)_\n";
  }
  return sections.join("\n\n");
}

/**
 * One-line per memory — used in SKILL.md TOC-style summaries.
 */
export function renderMemoryHeadlines(
  bucket: BundledMemory[],
  limit = 5
): string {
  if (bucket.length === 0) return "_none_";
  return bucket
    .slice(0, limit)
    .map((m) => `- **${m.created.slice(0, 10)}** — ${m.title} (\`${m.id}\`)`)
    .join("\n");
}

/**
 * Build a top-of-bundle summary block ("X decisions, Y learnings, …").
 */
export function renderStatsLine(bundle: SkillBundle): string {
  const s = bundle.stats;
  const parts: string[] = [];
  if (s.perBucket.decision > 0) parts.push(`${s.perBucket.decision} decisions`);
  if (s.perBucket.learning > 0) parts.push(`${s.perBucket.learning} learnings`);
  if (s.perBucket.observation > 0) parts.push(`${s.perBucket.observation} observations`);
  if (s.perBucket.entity > 0) parts.push(`${s.perBucket.entity} entities`);
  if (s.perBucket.question > 0) parts.push(`${s.perBucket.question} open questions`);
  if (s.perBucket.todo > 0) parts.push(`${s.perBucket.todo} todos`);
  if (s.perBucket.summary > 0) parts.push(`${s.perBucket.summary} summaries`);
  return parts.length === 0 ? "no memories yet" : parts.join(", ");
}
