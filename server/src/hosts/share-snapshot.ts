import type { ShareSnapshot } from "./types.js";

/**
 * Spec §5.3, as rebuilt in 2.14.1 after the persona tests: what a share code
 * carries, built by a pure function with no model call. The preview and the
 * stored snapshot are the same output.
 *
 * The rule it keeps: a shared artifact never quotes or describes private-talk
 * content, and never names anyone a player typed. It fails safe. When in
 * doubt, a sentence goes, and a part that loses too much goes whole.
 *
 * 1. Only the report card's sections about who the child became are kept:
 *    the title (rewritten to the child's name), Personality, Strengths and
 *    Struggles. Pivotal Moments, Voices, Quotes and any other section never
 *    go. If the Voices or Quotes heading is missing, the model didn't follow
 *    the format, and the whole card is left out.
 * 2. A sentence is dropped when it:
 *    - overlaps a quoted span of 2+ words, in any quote style, where the
 *      span may cross sentences and lines, and an unclosed quote runs to the
 *      end of its paragraph;
 *    - shares a run of 5 words with anything a player typed or anything said
 *      in private talk, or 6 words with the model's notes about the child
 *      (identity document, snapshots, memory summary), where the run may
 *      cross sentences and lines;
 *    - shares 3 distinctive word stems with one sentence of private talk (a
 *      paraphrase), or 2 stems that one private sentence has and nothing said
 *      in the open (shared chat, scenes, the child's shared lines) has;
 *    - talks about secrets or confidences;
 *    - names someone the game didn't generate (see `nameProblem`).
 * 3. A part that loses more than 40% of its sentences is left out.
 * 4. In what's left, the players' names and nicknames become "Parent 1" and
 *    "Parent 2" (H5). The child's name always wins.
 */

export const TYPED_RUN = 5;
export const DERIVED_RUN = 6;
export const QUOTED_WORDS = 2;
export const PARAPHRASE_STEMS = 3;
export const PRIVATE_ONLY_STEMS = 2;
export const MAX_DROPPED = 0.4;
const VOICES = "## The Voices in Their Head";
const QUOTES = "## Notable Quotes That Stuck";
const KEPT_SECTIONS = /^##\s+(personality|strengths|struggles)\b/i;
export const OMITTED_COPY = "your report card couldn't be trimmed safely, so a code would carry only the epilogue.";

export interface SnapshotSources {
  /** Everything a player typed: every chat (shared, private, debrief), confessionals, therapy. */
  typed: readonly string[];
  /** Private talk, from both sides: private and debrief chat (the child's lines too) and confessionals. */
  privateTalk: readonly string[];
  /** The model's notes about the child: identity document, its snapshots, the memory summary. */
  derived: readonly string[];
  childName: string;
  /** Text the world generated: scene descriptions, settings and triggers. */
  scenes: readonly string[];
  /** What the child said in shared chat (generated). */
  childLines: readonly string[];
  /** [display name, label], e.g. ["Ash", "Parent 1"]. */
  players: ReadonlyArray<readonly [string, string]>;
}

// ---- Words ----

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
interface Tok { raw: string; norm: string; start: number; end: number }

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(WORD)) {
    out.push({ raw: m[0], norm: m[0].toLowerCase().replace(/['’]/g, ""), start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

export function normaliseWords(text: string): string[] {
  return tokens(text).map((t) => t.norm);
}

const STOP = new Set(`a about above after again against all almost also always am an and any are around as at away back be became because become been before being below between both but by came can could did didnt do does doesnt doing done dont down during each even ever every few for from get gets getting go goes going gone got had has have having he her here hers herself him himself his how however i if in into is isnt it its itself just keep kept know knew known later least less let like little made make makes making many may me might more most much must my myself never no nor not nothing now of off often on once one only or other others our ours out over own quite rather really said same say says see seems she should since so some something sometimes still such take than that thats the their theirs them themselves then there these they thing things think this those though through time times to together too told toward under until up upon us very was wasnt way we well went were what whatever when where whether which while who whom whose why will with without would wouldnt yet you your yours yourself years year day days life people every everything someone anyone always also`.split(/\s+/));

/**
 * Relationship and person words. They count in every overlap and paraphrase
 * check ("my dad hit my mother at home" is exactly what must be caught); they
 * are only kept from looking like typed names at the start of a sentence.
 */
const FAMILY = new Set(`mother father mom mum dad mama papa mommy mummy daddy momma parent parents child children kid kids family home house love loved loves loving son daughter baby grandma grandpa granny nana grandmother grandfather aunt uncle brother sister boy girl man woman`.split(/\s+/));

/** A light Porter-style stem: enough to match "lullabies"/"lullaby" and "nights"/"night". */
function stem(w: string): string {
  let s = w.replace(/(?:'|’)s$/, "");
  if (s.length > 4 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 4 && s.endsWith("ly")) s = s.slice(0, -2);
  if (s.length > 3 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

// ---- Sentences ----

interface Span { start: number; end: number }
const ABBREV = /(?:^|[^\p{L}])(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Mt|Prof)$/u;

/** Sentence spans within [from, to) of text, keeping closing quotes with their sentence. */
function sentenceSpans(text: string, from = 0, to = text.length): Span[] {
  const out: Span[] = [];
  let start = from;
  while (start < to && /\s/.test(text[start])) start++;
  const re = /[.!?…]+["”’»)\]」』]*(?=\s+\S)/g;
  re.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m.index < to) {
    const end = m.index + m[0].length;
    if (end > to) break;
    if (m[0] === "." && ABBREV.test(text.slice(start, m.index))) continue;
    out.push({ start, end });
    start = end;
    while (start < to && /\s/.test(text[start])) start++;
    re.lastIndex = start;
  }
  let end = to;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end > start) out.push({ start, end });
  return out;
}

/** Splits a line into sentences, keeping closing quotes with their sentence. */
export function sentences(line: string): string[] {
  return sentenceSpans(line).map((s) => line.slice(s.start, s.end));
}

// ---- Quotes ----

const PAIRS: Record<string, string> = { "“": "”", "«": "»", "„": "“”", "‚": "‘’", "‹": "›", "「": "」", "『": "』", "‘": "’" };
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

function paragraphEnd(text: string, i: number): number {
  const j = text.indexOf("\n\n", i);
  return j < 0 ? text.length : j;
}

/** Every quoted span in the text, of any style; an unclosed one runs to the end of its paragraph. */
function quoteSpans(text: string): Span[] {
  const out: Span[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const para = paragraphEnd(text, i);
    let close = -1;
    let opened = false;
    if (c === '"') {
      opened = true;
      close = text.indexOf('"', i + 1);
      if (close > para) close = -1;
    } else if (c === "'" || c === "‘") {
      // A single quote opens only after a non-word character and before a letter (not "'90s", not "Wren's").
      if (!isWordChar(text[i - 1]) && /\p{L}/u.test(text[i + 1] ?? "")) {
        opened = true;
        const closer = c === "'" ? "'" : "’";
        for (let j = i + 1; j < para; j++) {
          if (text[j] === closer && !isWordChar(text[j + 1]) && !/\s/.test(text[j - 1])) { close = j; break; }
        }
      }
    } else if (PAIRS[c]) {
      opened = true;
      for (let j = i + 1; j < para; j++) if (PAIRS[c].includes(text[j])) { close = j; break; }
    }
    if (!opened) { i++; continue; }
    const end = close < 0 ? para : close + 1;
    out.push({ start: i, end });
    i = end;
  }
  return out.filter((s) => normaliseWords(text.slice(s.start, s.end)).length >= QUOTED_WORDS);
}

// ---- Copied runs ----

function runSet(texts: readonly string[], n: number): Set<string> {
  const set = new Set<string>();
  for (const t of texts) {
    const w = normaliseWords(t);
    for (let i = 0; i + n <= w.length; i++) {
      const run = w.slice(i, i + n);
      // A run of nothing but common words ("i dont know what to") proves nothing.
      if (run.some((x) => !STOP.has(x))) set.add(run.join(" "));
    }
  }
  return set;
}

/** Character ranges of the text that copy a run from a corpus, across sentence and line boundaries. */
function copiedSpans(text: string, banned: Set<string>, n: number): Span[] {
  const toks = tokens(text);
  const out: Span[] = [];
  for (let i = 0; i + n <= toks.length; i++) {
    if (banned.has(toks.slice(i, i + n).map((t) => t.norm).join(" "))) out.push({ start: toks[i].start, end: toks[i + n - 1].end });
  }
  return out;
}

// ---- Secrets and paraphrase ----

const SECRET = /\b(secrets?|secretly|confid(?:e|ed|es|ing|ant|ante|ants|ential|entially)|privately|in private|never told|confess\w*|just between)\b/i;

function stems(text: string, exclude: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const w of normaliseWords(text)) if (w.length >= 4 && !STOP.has(w) && !exclude.has(w)) out.add(stem(w));
  return out;
}

// ---- Names ----

const FIXED_ALLOW = new Set(`i ok okay mr mrs ms miss dr parent god
monday tuesday wednesday thursday friday saturday sunday mondays tuesdays wednesdays thursdays fridays saturdays sundays
january february march april may june july august september october november december
christmas easter thanksgiving halloween hanukkah passover ramadan eid diwali kwanzaa
mom mum dad mama papa mommy mummy daddy momma grandma grandpa granny gran nana grandmother grandfather mother father`.split(/\s+/));

const HONORIFIC = new Set(`bishop elder sister brother president pastor reverend rev father deacon rabbi imam coach aunt auntie uncle cousin sheriff officer judge professor prof captain sergeant saint st dr mr mrs ms miss`.split(/\s+/));

const DIMINUTIVES: string[][] = [
  "thomas tom tommy thom", "rebecca becca becky becks reba", "william will bill billy liam willy", "robert rob bob bobby robbie bert",
  "elizabeth liz lizzie beth betsy betty eliza libby", "michael mike mikey mick", "katherine catherine kate katie kathy cathy kat kit",
  "margaret maggie meg peggy greta", "richard rick dick richie", "james jim jimmy jamie", "jennifer jen jenny", "christopher chris topher",
  "christine christina chris tina", "alexander alex xander", "alexandra alex lexi", "edward ed eddie ted teddy ned", "benjamin ben benny",
  "samuel sam sammy", "samantha sam sammy", "joseph joe joey", "jonathan jon jonny", "john jack johnny", "nicholas nick nicky",
  "daniel dan danny", "matthew matt matty", "anthony tony", "andrew andy drew", "patricia pat patty trish", "patrick pat paddy",
  "susan sue suzy", "deborah deb debbie", "victoria vicky tori", "stephanie steph", "steven stephen steve", "gregory greg",
  "timothy tim timmy", "jessica jess jessie", "abigail abby", "charles charlie chuck", "charlotte charlie lottie", "henry hank harry",
  "harold harry hal", "beatrice bea trixie", "dorothy dot dottie", "frances fran frankie", "francis frank frankie", "lawrence larry",
  "leonard leo lenny", "madeline maddie", "nathaniel nathan nate", "olivia liv livvy", "penelope penny", "rachel rach",
  "ronald ron ronnie", "donald don donnie", "theodore theo ted teddy", "zachary zach zack", "ashley ash", "natalie nat",
  "isabella isabel izzy bella", "gabriel gabe", "gabrielle gabby",
].map((g) => g.split(" "));

function stripPossessive(w: string): string {
  return w.replace(/['’]s$/i, "");
}

/** A token's lookup form: possessive dropped from the raw word, then normalised ("Daddy’s" → "daddy"). */
const baseNorm = (raw: string) => stripPossessive(raw).toLowerCase().replace(/['’]/g, "");

function nameCore(w: string): string {
  let s = w.toLowerCase();
  for (const suf of ["ie", "ey", "y", "a", "o", "s", "i"]) {
    if (s.endsWith(suf) && s.length - suf.length >= 3) { s = s.slice(0, -suf.length); break; }
  }
  if (/([^aeiou])\1$/.test(s) && s.length > 3) s = s.slice(0, -1);
  return s;
}

/** Is this word one of the player's names: the name itself, a listed diminutive, or a nickname built on it (Becca, Tommy)? */
function isVariant(word: string, player: string): boolean {
  const w = stripPossessive(word).toLowerCase();
  const p = player.trim().toLowerCase();
  if (!p || !w) return false;
  if (w === p) return true;
  if (/\s/.test(p)) return p.split(/\s+/).some((part) => isVariant(word, part));
  if (p.length < 3 || w.length < 3) return false;
  if (DIMINUTIVES.some((g) => g.includes(w) && g.includes(p))) return true;
  const cw = nameCore(w);
  const cp = nameCore(p);
  if (cw === cp) return true;
  // A short form cut from a long name: Becca from Rebecca, Rob and Bert from Robert.
  return cp.length >= 5 && cw.length >= 3 && cw.length < cp.length && (cp.startsWith(cw) || cp.endsWith(cw));
}

interface NameContext {
  child: Set<string>;
  allowed: Set<string>;
  players: ReadonlyArray<readonly [string, string]>;
  typedLower: Set<string>;
  typedCapsMid: Set<string>;
  partCapsMid: Set<string>;
  reference: Set<string>;
}

const isCap = (w: string) => /^\p{Lu}/u.test(w);
const isAllCaps = (w: string) => w.length >= 2 && w === w.toUpperCase() && /\p{Lu}/u.test(w);

/** Tokens of a sentence, each marked as in an initial-like position (start, after ":" or a dash, in a leading bold label). */
function positioned(text: string): Array<Tok & { initial: boolean }> {
  const toks = tokens(text);
  const bold = /^\s*(?:(?:[-*]|\d+\.)\s+)?\*\*([^*]+)\*\*/.exec(text);
  const boldEnd = bold ? bold[0].length : -1;
  return toks.map((t, i) => {
    const gap = text.slice(i === 0 ? 0 : toks[i - 1].end, t.start);
    const firstAfterLabel = boldEnd >= 0 && t.start >= boldEnd && (i === 0 || toks[i - 1].end <= boldEnd);
    const initial = i === 0 || t.end <= boldEnd || firstAfterLabel || /[:;—–(\[“"‘«„]|\s-\s/.test(gap);
    return { ...t, initial };
  });
}

function capsMid(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    for (const line of text.split("\n")) {
      for (const s of sentences(line)) {
        for (const t of positioned(s)) if (!t.initial && isCap(t.raw) && !isAllCaps(t.raw)) out.add(baseNorm(t.raw));
      }
    }
  }
  return out;
}

function lowerWords(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const k of tokens(t)) if (!isCap(k.raw)) { out.add(k.norm); out.add(baseNorm(k.raw)); }
  return out;
}

/**
 * Does this sentence name someone the game didn't generate?
 * - A capitalised word mid-sentence must be the child's name, a name the
 *   world generated (that no player also typed), a day, month, holiday or
 *   family word, or one of the players' names (redacted afterwards).
 * - A capitalised word at the start of a sentence (or of a label) goes when
 *   it's a title (Bishop, Elder, Aunt), when it's written capitalised
 *   mid-sentence elsewhere (in what the players typed or in this text), or
 *   when a player typed it and the generated text never uses it as an
 *   ordinary lowercase word ("gary" typed lowercase is still a name).
 */
function nameProblem(sentence: string, ctx: NameContext): boolean {
  for (const t of positioned(sentence)) {
    if (!isCap(t.raw) || isAllCaps(t.raw)) continue;
    const w = baseNorm(t.raw);
    if (ctx.child.has(w) || FIXED_ALLOW.has(w) || ctx.allowed.has(w)) continue;
    if (ctx.players.some(([p]) => isVariant(t.raw, p))) continue;
    if (!t.initial) return true;
    if (HONORIFIC.has(w)) return true;
    if (ctx.typedCapsMid.has(w) || ctx.partCapsMid.has(w)) return true;
    if (ctx.typedLower.has(w) && !ctx.reference.has(w) && !STOP.has(w) && !FAMILY.has(w)) return true;
  }
  return false;
}

// ---- Scrubbing a part ----

interface Unit extends Span { line: number }
interface Checks {
  typedRuns: Set<string>;
  derivedRuns: Set<string>;
  privateStems: Set<string>[];
  /** Per private sentence, its stems found nowhere in shared chat or generated text. */
  privateOnly: Set<string>[];
  stemExclude: Set<string>;
  names: NameContext;
  /** When set, each dropped sentence is reported with its reason (for tests and local debugging). */
  explain?: Array<{ reason: string; sentence: string }>;
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
const shared = (a: Set<string>, b: Set<string>) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

/**
 * Scrubs one part. Headings are structural: kept, not counted, and dropped if
 * nothing is left under them. Null if more than 40% of the sentences went.
 */
function scrubPart(text: string, checks: Checks): string | null {
  const lines: Array<{ start: number; end: number; heading: boolean; bullet: string }> = [];
  let at = 0;
  for (const raw of text.split("\n")) {
    const bullet = /^(\s*(?:[-*]|\d+\.)\s+)/.exec(raw)?.[1] ?? "";
    lines.push({ start: at, end: at + raw.length, heading: /^#{1,6}\s/.test(raw), bullet });
    at += raw.length + 1;
  }
  const units: Unit[] = [];
  lines.forEach((l, i) => {
    if (l.heading || l.end === l.start) return;
    for (const s of sentenceSpans(text, l.start + l.bullet.length, l.end)) units.push({ ...s, line: i });
  });
  const quotes = quoteSpans(text);
  const copied = [...copiedSpans(text, checks.typedRuns, TYPED_RUN), ...copiedSpans(text, checks.derivedRuns, DERIVED_RUN)];
  const dropped = new Set<Unit>();
  for (const u of units) {
    const s = text.slice(u.start, u.end);
    const mine = stems(s, checks.stemExclude);
    const reason =
      quotes.some((b) => overlaps(b, u)) ? "quote"
      : copied.some((b) => overlaps(b, u)) ? "copied run"
      : SECRET.test(s) ? "secret"
      : nameProblem(s, checks.names) ? "name"
      : checks.privateStems.some((p) => shared(mine, p) >= PARAPHRASE_STEMS) ? "paraphrase"
      : checks.privateOnly.some((p) => shared(mine, p) >= PRIVATE_ONLY_STEMS) ? "private-only words"
      : null;
    if (reason) { dropped.add(u); checks.explain?.push({ reason, sentence: s }); }
  }
  if (units.length === 0 || dropped.size / units.length > MAX_DROPPED) return null;

  const out: string[] = [];
  lines.forEach((l, i) => {
    if (l.heading) { out.push(text.slice(l.start, l.end).trimEnd()); return; }
    if (l.end === l.start || !text.slice(l.start, l.end).trim()) { out.push(""); return; }
    const kept = units.filter((u) => u.line === i && !dropped.has(u)).map((u) => text.slice(u.start, u.end).trim());
    if (kept.length) out.push(l.bullet + kept.join(" "));
  });
  // A heading with nothing under it before the next heading goes.
  const tidy: string[] = [];
  for (let i = 0; i < out.length; i++) {
    if (/^#{2,6}\s/.test(out[i])) {
      let j = i + 1;
      while (j < out.length && out[j] === "") j++;
      if (j >= out.length || /^#{1,6}\s/.test(out[j])) continue;
    }
    tidy.push(out[i]);
  }
  return tidy.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The card's title and kept sections. Null if a Voices or Quotes heading is missing, or nothing is kept. */
function keptSections(card: string, childName: string): string | null {
  const lines = card.split("\n");
  if (!lines.some((l) => l.trim() === VOICES) || !lines.some((l) => l.trim() === QUOTES)) return null;
  const out: string[] = [];
  let keep = false;
  let any = false;
  for (const line of lines) {
    if (/^#\s/.test(line)) { keep = false; continue; }
    if (/^##\s/.test(line)) {
      keep = KEPT_SECTIONS.test(line.trim());
      if (keep) { any = true; out.push("", line.trim()); }
      continue;
    }
    if (keep) out.push(line);
  }
  if (!any) return null;
  return [`# ${childName.trim() || "your child"}`, ...out].join("\n");
}

/** Replaces the players' names and nicknames with their labels; the child's name always wins. */
export function redactNames(text: string, players: ReadonlyArray<readonly [string, string]>, childName = ""): string {
  const child = new Set(normaliseWords(childName));
  let out = text;
  // A multi-word display name ("Mary Ann") as a whole first.
  for (const [name, label] of players) {
    const n = name.trim();
    if (!/\s/.test(n)) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "giu"), label);
  }
  out = out.replace(WORD, (word) => {
    const base = stripPossessive(word);
    if (child.has(base.toLowerCase().replace(/['’]/g, ""))) return word;
    for (const [name, label] of players) {
      const exact = base.toLowerCase() === name.trim().toLowerCase();
      if (exact || (isCap(word) && isVariant(base, name))) return label + word.slice(base.length);
    }
    return word;
  });
  return out;
}

export function buildShareSnapshot(
  reportCard: string | null,
  epilogue: string | null,
  src: SnapshotSources,
  explain?: Array<{ reason: string; sentence: string }>,
): ShareSnapshot {
  const child = new Set(normaliseWords(src.childName));
  const typedTokens = new Set(src.typed.flatMap((t) => tokens(t).flatMap((k) => [k.norm, baseNorm(k.raw)])));
  const generated = new Set<string>();
  for (const t of [...src.scenes, ...src.childLines]) {
    for (const k of tokens(t)) if (isCap(k.raw)) generated.add(baseNorm(k.raw));
  }
  for (const w of [...generated]) if (typedTokens.has(w)) generated.delete(w);

  const card = reportCard ? keptSections(reportCard, src.childName) : null;
  const parts = [card ?? "", epilogue ?? ""];
  const playerWords = new Set(src.players.flatMap(([n]) => normaliseWords(n)));
  const privateSentences = src.privateTalk.flatMap((t) => t.split("\n").flatMap((l) => sentences(l)));
  const stemExclude = new Set([...child, ...playerWords]);
  // Words the game says in the open: shared chat (typed lines that aren't private talk), scenes, the child's shared lines.
  const privateSet = new Set(src.privateTalk);
  const openStems = stems([...src.typed.filter((t) => !privateSet.has(t)), ...src.scenes, ...src.childLines].join("\n"), new Set());
  const checks: Checks = {
    typedRuns: runSet([...src.typed, ...src.privateTalk], TYPED_RUN),
    derivedRuns: runSet(src.derived, DERIVED_RUN),
    privateStems: privateSentences.map((s) => stems(s, stemExclude)).filter((s) => s.size >= PARAPHRASE_STEMS),
    privateOnly: privateSentences
      .map((s) => new Set([...stems(s, stemExclude)].filter((x) => !openStems.has(x))))
      .filter((s) => s.size >= PRIVATE_ONLY_STEMS),
    stemExclude,
    explain,
    names: {
      child,
      allowed: generated,
      players: src.players,
      typedLower: typedTokens,
      typedCapsMid: capsMid(src.typed),
      partCapsMid: capsMid(parts),
      reference: lowerWords([...src.scenes, ...src.childLines, ...src.derived, ...parts]),
    },
  };
  const scrubbedCard = card === null ? null : scrubPart(card, checks);
  const scrubbedEpilogue = epilogue ? scrubPart(epilogue, checks) : null;
  // A card with nothing left under its title carries nothing.
  const cardOut = scrubbedCard !== null && /\n\s*##\s/.test(scrubbedCard) ? scrubbedCard : null;
  return {
    reportCard: cardOut === null ? null : redactNames(cardOut, src.players, src.childName),
    epilogue: scrubbedEpilogue === null ? null : redactNames(scrubbedEpilogue, src.players, src.childName),
    reportCardOmitted: cardOut === null,
  };
}

/** Can this snapshot carry anything at all? (Neither part: behaves like an excluded game.) */
export function snapshotEmpty(s: ShareSnapshot): boolean {
  return s.reportCard === null && s.epilogue === null;
}
