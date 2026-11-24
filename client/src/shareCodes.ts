/**
 * Meetup host tools, share codes (spec §5, build plan B.4/B.5): the shapes the
 * share step, the account page and the host's code view read, and the lines
 * they build from them.
 *
 * Pure and DOM-free so it runs under `node --test`. Nothing here tracks
 * anything, and nothing here stores a code, its words or its ref.
 */

import { asFunnel, formatDate, funnelLine, type PublishedFunnel } from "./hostPortal";
import { asCard, type MeetupCard, type TextRun } from "./meetupCard";

const isStr = (v: unknown): v is string => typeof v === "string";
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ---- The snapshot (identical for the preview and a code) ----

export interface ShareSnapshot {
  reportCard: string | null;
  epilogue: string | null;
  reportCardOmitted: boolean;
}

export function asSnapshot(v: unknown): ShareSnapshot | null {
  if (!isRec(v)) return null;
  if (v.reportCard !== null && !isStr(v.reportCard)) return null;
  if (v.epilogue !== null && !isStr(v.epilogue)) return null;
  return { reportCard: v.reportCard as string | null, epilogue: v.epilogue as string | null, reportCardOmitted: v.reportCardOmitted === true };
}

export type SnapshotBlock = { kind: "h1" | "h2" | "h3" | "p"; text: string };

/**
 * Markdown to headings and paragraphs, nothing else (spec §5.3 step 4). Every
 * non-empty line is one block. A list marker or `>` is dropped and the line
 * becomes a paragraph; `**` emphasis markers are dropped. Links and images
 * stay as the literal text they are: the blocks are rendered as React text.
 */
export function markdownBlocks(md: string): SnapshotBlock[] {
  const out: SnapshotBlock[] = [];
  for (const raw of md.split("\n")) {
    let line = raw.trim();
    if (!line) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    let kind: SnapshotBlock["kind"] = "p";
    if (h) {
      kind = h[1].length === 1 ? "h1" : h[1].length === 2 ? "h2" : "h3";
      line = h[2];
    } else {
      line = line.replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s*)/, "");
    }
    const text = line.replace(/\*\*/g, "").trim();
    if (text) out.push({ kind, text });
  }
  return out;
}

/** The heading put before the epilogue's paragraphs. */
export const EPILOGUE_HEADING = "epilogue";

/** The snapshot's blocks, report card first, then the epilogue under its own heading. */
export function snapshotBlocks(s: ShareSnapshot): SnapshotBlock[] {
  const blocks: SnapshotBlock[] = [];
  if (s.reportCard) blocks.push(...markdownBlocks(s.reportCard));
  if (s.epilogue) {
    const ep = markdownBlocks(s.epilogue);
    if (ep.length > 0) blocks.push({ kind: "h2", text: EPILOGUE_HEADING }, ...ep);
  }
  return blocks;
}

export const CARRIES_NOTHING = "a code for this game would carry nothing.";
export const REPORT_CARD_OMITTED = "your report card couldn't be trimmed safely, so a code would carry only the epilogue.";

// ---- The share step (end screen) ----

export type ShareView =
  | { state: "ask" }
  | { state: "waiting" }
  | { state: "no" }
  | { state: "later"; until: number };

export type ShareMessage =
  | { view: ShareView }
  | { preview: ShareSnapshot | null }
  | { error: string };

function asView(v: unknown): ShareView | null {
  if (!isRec(v)) return null;
  if (v.state === "ask" || v.state === "waiting" || v.state === "no") return { state: v.state };
  if (v.state === "later" && isTime(v.until)) return { state: "later", until: v.until };
  return null;
}

/** A SHARE_STATE payload, or null when it isn't one. */
export function asShareMessage(v: unknown): ShareMessage | null {
  if (!isRec(v)) return null;
  if ("view" in v) {
    const view = asView(v.view);
    return view ? { view } : null;
  }
  if ("preview" in v) {
    if (v.preview === null) return { preview: null };
    const s = asSnapshot(v.preview);
    return s ? { preview: s } : null;
  }
  if (isStr(v.error)) return { error: v.error };
  return null;
}

export const shareQuestion = (host: string) => `make a share code for ${host}?`;
export const shareExplains = (host: string) =>
  `a share code lets ${host} read your report card (without its quotes) and your child's epilogue. both were written from your whole game, including your private talks with your child. they don't show those talks, but they can reflect them.`;
export const SHARE_SILENCE =
  "RI won't tell your co-parent what you chose. if one of you says yes and no code appears, that can mean the other said no, or is deciding later, or that this game can't make a code. RI never says which.";
export const previewButton = (host: string) => `show me exactly what ${host} would see`;
export const previewTitle = (host: string) => `this is everything ${host} would see.`;

/** What a seat sees after answering (spec §5.1 step 5); null for "ask", which is the question itself. */
export function shareViewLine(view: ShareView, timeZone?: string): string | null {
  switch (view.state) {
    case "waiting": return "if your co-parent says yes too, a code will appear on your account page.";
    case "no": return "okay, nothing will be made.";
    case "later": return `you can decide on your account page until ${formatDate(view.until, timeZone)}.`;
    default: return null;
  }
}

/**
 * Whether the handle exchange (if on) shows yet: after the share step has an
 * answer, or when there is no share step, or when the server refused it (a
 * refusal must never hide the screens after it).
 */
export function handlesAfterShare(shareOn: boolean, latest: ShareMessage | null): boolean {
  if (!shareOn) return true;
  if (!latest) return false;
  if ("error" in latest) return true;
  if ("view" in latest) return latest.view.state !== "ask";
  return false;
}

// ---- Studio learning (end screen, studio events) ----

export type LearningMessage = { view: { answered: boolean } } | { error: string };

/** A STUDIO_LEARNING_STATE payload, or null when it isn't one. */
export function asLearningMessage(v: unknown): LearningMessage | null {
  if (!isRec(v)) return null;
  if ("view" in v) {
    return isRec(v.view) && typeof v.view.answered === "boolean" ? { view: { answered: v.view.answered } } : null;
  }
  if (isStr(v.error)) return { error: v.error };
  return null;
}

export const LEARNING_QUESTION = "can the studio learn from your game?";
export const LEARNING_EXPLAINS =
  "the studio would read your game, including private talks, to improve stranger mode. it's never published, never in a blog post and never used to train AI. it only happens if you both say yes, and RI won't tell your co-parent what you chose.";
/** H20: two equal answers, in this order, and neither is the default. */
export const LEARNING_ANSWERS: ReadonlyArray<{ answer: "yes" | "no"; label: string }> = [
  { answer: "yes", label: "yes, let the studio learn from our game" },
  { answer: "no", label: "no" },
];
/** The same line whatever was chosen. */
export const LEARNING_NOTED = "thanks. that's noted.";

/** Has the learning step let the screens after it show? An answer, or a refusal (which must never hide them). */
function afterLearning(on: boolean, latest: LearningMessage | null): boolean {
  if (!on) return true;
  if (!latest) return false;
  if ("error" in latest) return true;
  return latest.view.answered;
}

/**
 * The end screens after the report card (spec §5.1 step 2): share step →
 * studio learning → handle exchange. Studio learning shows once the share
 * step lets it; the handle exchange waits for both.
 */
export function endSteps(
  shareOn: boolean,
  shareLatest: ShareMessage | null,
  learningOn: boolean,
  learningLatest: LearningMessage | null,
): { learning: boolean; handles: boolean } {
  const shared = handlesAfterShare(shareOn, shareLatest);
  return { learning: learningOn && shared, handles: shared && afterLearning(learningOn, learningLatest) };
}

// ---- The account page ----

export type ShareRow =
  | { state: "waiting" }
  | { state: "later"; until: number }
  | { state: "code"; words: string; host: string; until: number; opened: number[] }
  | { state: "stopped"; at: number }
  | { state: "none" };

export interface AccountMeetup { ref: string; name: string; at: number; card: MeetupCard | null }
/** This seat's own studio-learning answer; null when it wasn't offered at that event. */
export type LearningRow = "yes" | "no" | "unanswered" | null;
export interface AccountGame {
  ref: string;
  childName: string;
  eventName: string;
  share: ShareRow | null;
  learning: LearningRow;
  /** "requested": asked the studio to take this game off the account, not done yet. */
  unlink: "requested" | null;
}
export type HostPanel = { kind: "nothing" } | { kind: "pending" } | { kind: "funnel"; funnel: PublishedFunnel };
export interface HostSaw { name: string; panel: HostPanel }
export interface AccountPage { meetups: AccountMeetup[]; games: AccountGame[]; hostSaw: HostSaw[] }

/** A share row, null for "no share step in this game", or undefined when it isn't one. */
export function asShareRow(v: unknown): ShareRow | null | undefined {
  if (v === null) return null;
  if (!isRec(v)) return undefined;
  switch (v.state) {
    case "waiting": return { state: "waiting" };
    case "none": return { state: "none" };
    case "later": return isTime(v.until) ? { state: "later", until: v.until } : undefined;
    case "stopped": return isTime(v.at) ? { state: "stopped", at: v.at } : undefined;
    case "code":
      if (!isStr(v.words) || !v.words || !isStr(v.host) || !isTime(v.until)) return undefined;
      if (!Array.isArray(v.opened) || !v.opened.every(isTime)) return undefined;
      return { state: "code", words: v.words, host: v.host, until: v.until, opened: [...(v.opened as number[])] };
    default: return undefined;
  }
}

/** A game row's learning answer; anything unknown is null (shown as nothing). */
export function asLearningRow(v: unknown): LearningRow {
  return v === "yes" || v === "no" || v === "unanswered" ? v : null;
}

/** The player's own studio-learning answer on the account page; null shows nothing. */
export function learningLine(l: LearningRow): string | null {
  switch (l) {
    case "yes": return "studio learning: you said yes.";
    case "no": return "studio learning: you said no.";
    case "unanswered": return "studio learning: you didn't answer.";
    default: return null;
  }
}

/** "take this game off my account" (spec §6), exactly. */
export const UNLINK_WARNING =
  "the studio will take this game off your account and cancel any code. your co-parent keeps their copy of the game, which includes what you wrote, without your name.";
export const UNLINK_REQUESTED =
  "you asked the studio to take this game off your account. it will disappear from this page when that's done.";

function asPanel(v: unknown): HostPanel | null {
  if (!isRec(v)) return null;
  if (v.kind === "nothing" || v.kind === "pending") return { kind: v.kind };
  if (v.kind === "funnel") {
    const f = asFunnel(v.funnel);
    return f ? { kind: "funnel", funnel: f } : null;
  }
  return null;
}

/** The /stranger/account body, or null. Malformed entries are dropped, not guessed at. */
export function asAccountPage(v: unknown): AccountPage | null {
  if (!isRec(v) || !Array.isArray(v.meetups) || !Array.isArray(v.games) || !Array.isArray(v.hostSaw)) return null;
  const meetups: AccountMeetup[] = [];
  for (const m of v.meetups) {
    if (!isRec(m) || !isStr(m.ref) || !m.ref || !isStr(m.name) || !isTime(m.at)) continue;
    meetups.push({ ref: m.ref, name: m.name, at: m.at, card: asCard(m.card) });
  }
  const games: AccountGame[] = [];
  for (const g of v.games) {
    if (!isRec(g) || !isStr(g.ref) || !g.ref || !isStr(g.childName) || !isStr(g.eventName)) continue;
    const share = asShareRow(g.share);
    if (share === undefined) continue;
    games.push({
      ref: g.ref, childName: g.childName, eventName: g.eventName, share,
      learning: asLearningRow(g.learning),
      unlink: g.unlink === "requested" ? "requested" : null,
    });
  }
  const hostSaw: HostSaw[] = [];
  for (const h of v.hostSaw) {
    if (!isRec(h) || !isStr(h.name)) continue;
    const panel = asPanel(h.panel);
    if (panel) hostSaw.push({ name: h.name, panel });
  }
  return { meetups, games, hostSaw };
}

/** "november 20, 2026", "november 20, 2026 and november 21, 2026", "a, b and c": one per day. */
export function formatDates(times: number[], timeZone?: string): string {
  const days: string[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const d = formatDate(t, timeZone);
    if (!days.includes(d)) days.push(d);
  }
  if (days.length <= 1) return days.join("");
  return `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`;
}

export interface ShareRowLines {
  /** The row's line; a code's words are its one bold run. */
  runs: TextRun[];
  /** A code's access log. */
  access?: string;
  /** "later": offer "decide now". "code": offer "stop this code". */
  action?: "decide" | "stop";
}

/** One game's share state as the account page writes it (spec §B.5). */
export function shareRowLines(row: ShareRow, timeZone?: string): ShareRowLines {
  const plain = (text: string): TextRun[] => [{ text, bold: false }];
  switch (row.state) {
    case "waiting":
      return { runs: plain("you said yes. if your co-parent says yes too, a code will appear here.") };
    case "later":
      return { runs: plain(`you haven't decided yet. you can until ${formatDate(row.until, timeZone)}.`), action: "decide" };
    case "stopped":
      return { runs: plain(`you stopped this code on ${formatDate(row.at, timeZone)}.`) };
    case "none":
      return { runs: plain("no code was made for this game.") };
    case "code": {
      const h = row.host;
      return {
        runs: [
          { text: `share code for ${h}: `, bold: false },
          { text: row.words, bold: true },
          { text: `. give it to ${h} when and if you want to. it works for ${h} only, until ${formatDate(row.until, timeZone)}.`, bold: false },
        ],
        access: row.opened.length > 0 ? `${h} opened it on ${formatDates(row.opened, timeZone)}.` : `${h} hasn't opened it.`,
        action: "stop",
      };
    }
  }
}

export const stopWarning = (host: string) =>
  `stopping it means ${host} can't open it again. it can't make ${host} forget what they've already read. ${host} will see that it no longer opens, and might say so in front of your co-parent.`;

export const PANEL_PENDING = "nothing yet. numbers, if there are any, appear a day after the meetup closes.";
export const PANEL_NOTHING = "nothing.";

/** What the host saw of one meetup (the published panel, or why there isn't one). */
export function panelLine(p: HostPanel): string {
  if (p.kind === "pending") return PANEL_PENDING;
  if (p.kind === "nothing") return PANEL_NOTHING;
  return funnelLine(p.funnel) ?? PANEL_NOTHING;
}

/**
 * The host's name for a game's event, from the card the player agreed to (a
 * "later" row carries no host name). Falls back as the server does.
 */
export function hostForEvent(meetups: AccountMeetup[], eventName: string): string {
  return meetups.find((m) => m.name === eventName && m.card?.hostName)?.card?.hostName ?? "your host";
}

/** "report this host": the one host's name when every card agrees on it. */
export function reportHostName(meetups: AccountMeetup[]): string {
  const names = new Set(meetups.map((m) => m.card?.hostName).filter((n): n is string => !!n));
  return names.size === 1 ? [...names][0] : "the host";
}

// ---- The host's code view ----

export interface CodeView {
  snapshot: ShareSnapshot;
  until: number;
  watermark: { reader: string; openedAt: number };
}

export function asCodeView(v: unknown): CodeView | null {
  if (!isRec(v) || !isTime(v.until) || !isRec(v.watermark)) return null;
  const snapshot = asSnapshot(v.snapshot);
  if (!snapshot || !isStr(v.watermark.reader) || !isTime(v.watermark.openedAt)) return null;
  return { snapshot, until: v.until, watermark: { reader: v.watermark.reader, openedAt: v.watermark.openedAt } };
}

/** On every block of a code view (spec §B.5). */
export function watermarkLine(w: { reader: string; openedAt: number }, timeZone?: string): string {
  return `opened by ${w.reader} on ${formatDate(w.openedAt, timeZone)} · for a conversation with this pair only · don't copy or share`;
}

export const CODE_NOT_AVAILABLE = "this code isn't available.";
export const openUntil = (until: number, timeZone?: string) => `you can open this until ${formatDate(until, timeZone)}.`;

// ---- The account pass, kept for this tab ----

export const ACCOUNT_PASS_KEY = "ri_account_pass";

interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function session(): KV | null {
  try {
    return (globalThis as { sessionStorage?: KV }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function loadAccountPass(store: KV | null = session()): string | null {
  try { return store?.getItem(ACCOUNT_PASS_KEY) || null; } catch { return null; }
}

export function saveAccountPass(pass: string | null, store: KV | null = session()): void {
  try {
    if (pass) store?.setItem(ACCOUNT_PASS_KEY, pass);
    else store?.removeItem(ACCOUNT_PASS_KEY);
  } catch { /* private window */ }
}

/** `?stranger=account` opens the account page. */
export function isAccountRoute(search: string): boolean {
  return new URLSearchParams(search).get("stranger") === "account";
}

/**
 * The account-pass probe on arrival: host tools answer this route with JSON
 * (a 401 without a token); anything else means they're off and the normal
 * title screen shows.
 */
export function accountRouteOn(status: number, json: boolean): boolean {
  return json && (status === 401 || status === 200);
}
