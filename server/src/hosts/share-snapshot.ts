import type { ShareSnapshot } from "./types.js";

/**
 * Spec §5.3: what a share code carries, built by a pure function, with no
 * model call. The preview and the stored snapshot are the same output.
 *
 * 1. The report card loses "The Voices in Their Head" and "Notable Quotes
 *    That Stuck". If either heading is missing, the whole card is left out.
 * 2. Every sentence that shares 6+ consecutive normalised words with anything
 *    in the corpus, or carries a quoted span of 4+ words, is dropped.
 * 3. A part that loses more than 40% of its sentences is left out.
 *
 * The corpus is every parent message in every chat (shared, private and
 * debrief, so sidebars included) and, beyond the spec, the other inputs the
 * report card and epilogue are written from: confessionals, the identity
 * document and the memory summary. The Psychologist reads whole scenes,
 * sidebars included, into its identity notes, and those notes feed the
 * report card and epilogue; a sentence copied from them is dropped here.
 */

export const RUN_WORDS = 6;
export const QUOTED_WORDS = 4;
export const MAX_DROPPED = 0.4;
const VOICES = "## The Voices in Their Head";
const QUOTES = "## Notable Quotes That Stuck";
export const OMITTED_COPY = "your report card couldn't be trimmed safely, so a code would carry only the epilogue.";

export function normaliseWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function runs(words: string[], n = RUN_WORDS): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" "));
  return out;
}

export function corpusRuns(corpus: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const text of corpus) for (const r of runs(normaliseWords(text))) set.add(r);
  return set;
}

function hasLongQuote(sentence: string): boolean {
  const re = /“([^”]*)”|"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence))) {
    if (normaliseWords(m[1] ?? m[2] ?? "").length >= QUOTED_WORDS) return true;
  }
  return false;
}

function dropSentence(sentence: string, banned: Set<string>): boolean {
  if (hasLongQuote(sentence)) return true;
  return runs(normaliseWords(sentence)).some((r) => banned.has(r));
}

/** Splits a line into sentences, keeping closing quotes with their sentence. */
export function sentences(line: string): string[] {
  return line.split(/(?<=[.!?…]["”’)]?)\s+(?=\S)/).filter((s) => s.trim().length > 0);
}

/**
 * Scrubs one part. Headings are scrubbed like sentences but not counted;
 * returns null if more than 40% of the counted sentences went.
 */
export function scrubPart(text: string, banned: Set<string>): string | null {
  let total = 0;
  let dropped = 0;
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) { out.push(""); continue; }
    if (/^#{1,6}\s/.test(line)) {
      if (!dropSentence(line, banned)) out.push(line);
      continue;
    }
    const bullet = /^(\s*[-*]\s+)/.exec(line)?.[1] ?? "";
    const kept: string[] = [];
    for (const s of sentences(line.slice(bullet.length))) {
      total++;
      if (dropSentence(s, banned)) dropped++;
      else kept.push(s.trim());
    }
    if (kept.length) out.push(bullet + kept.join(" "));
  }
  if (total === 0 || dropped / total > MAX_DROPPED) return null;
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Removes a "## " section by its exact heading, up to the next "## " heading. Null if the heading isn't there. */
export function removeSection(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/** Whole-word, case-insensitive replacement of the parents' display names (H5). */
export function redactNames(text: string, names: ReadonlyArray<readonly [string, string]>): string {
  let out = text;
  for (const [name, label] of names) {
    const n = name.trim();
    if (n.length < 2) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "giu"), label);
  }
  return out;
}

export function buildShareSnapshot(
  reportCard: string | null,
  epilogue: string | null,
  corpus: readonly string[],
  names: ReadonlyArray<readonly [string, string]> = [],
): ShareSnapshot {
  const banned = corpusRuns(corpus);
  // Scrub the text as written (a name inside a copied run must not break the match), then redact names.
  let card: string | null = null;
  if (reportCard) {
    const noVoices = removeSection(reportCard, VOICES);
    const trimmed = noVoices === null ? null : removeSection(noVoices, QUOTES);
    card = trimmed === null ? null : scrubPart(trimmed, banned);
  }
  const ep = epilogue ? scrubPart(epilogue, banned) : null;
  return {
    reportCard: card === null ? null : redactNames(card, names),
    epilogue: ep === null ? null : redactNames(ep, names),
    reportCardOmitted: card === null,
  };
}

/** Can this snapshot carry anything at all? (Neither part: behaves like an excluded game.) */
export function snapshotEmpty(s: ShareSnapshot): boolean {
  return s.reportCard === null && s.epilogue === null;
}
