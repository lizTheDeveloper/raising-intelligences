/**
 * The meetup event card (host tools spec §3, build plan B.4): the card's
 * shape, its `**bold**` text, the acknowledgement kept for the rest of the
 * tab's session, and dropping the meetup code from the address bar.
 *
 * Pure and DOM-free so it runs under `node --test`. Nothing here tracks
 * anything, and the meetup code is never written anywhere by this module.
 */

export type CardStatus = "open" | "paused" | "closed" | "full" | "not_open_yet";

export interface CardSection {
  heading?: string;
  paragraphs?: string[];
  bullets?: string[];
}

export interface MeetupCard {
  version: number;
  prototype: true;
  eventName: string;
  status: CardStatus;
  lead: string;
  hostLine: string;
  welcome: string;
  sections: CardSection[];
  invite: string;
  notForMe: string[];
  conductUrl: string | null;
  hostName: string | null;
  shareCodes: boolean;
}

const STATUSES: readonly string[] = ["open", "paused", "closed", "full", "not_open_yet"];

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function isSection(v: unknown): v is CardSection {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (s.heading === undefined || isStr(s.heading))
    && (s.paragraphs === undefined || isStrList(s.paragraphs))
    && (s.bullets === undefined || isStrList(s.bullets));
}

/** A card the client can render, or null: anything else means "no card" and the app behaves as before. */
export function asCard(v: unknown): MeetupCard | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (typeof c.version !== "number" || !Number.isFinite(c.version)) return null;
  if (!isStr(c.status) || !STATUSES.includes(c.status)) return null;
  if (!isStr(c.eventName) || !isStr(c.lead) || !isStr(c.hostLine) || !isStr(c.welcome) || !isStr(c.invite)) return null;
  if (!Array.isArray(c.sections) || !c.sections.every(isSection)) return null;
  if (!isStrList(c.notForMe)) return null;
  if (c.conductUrl !== null && !isStr(c.conductUrl)) return null;
  if (c.hostName !== null && !isStr(c.hostName)) return null;
  return {
    version: c.version,
    prototype: true,
    eventName: c.eventName,
    status: c.status as CardStatus,
    lead: c.lead,
    hostLine: c.hostLine,
    welcome: c.welcome,
    sections: c.sections as CardSection[],
    invite: c.invite,
    notForMe: c.notForMe,
    conductUrl: c.conductUrl as string | null,
    hostName: c.hostName as string | null,
    shareCodes: c.shareCodes === true,
  };
}

/** Only an https link is ever rendered as the code-of-conduct href. */
export function safeHttpsUrl(u: string | null): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export interface TextRun {
  text: string;
  bold: boolean;
}

/**
 * Splits card text on `**bold**` markers. Nothing else is markup: the runs are
 * rendered as React text (escaped), so `<b>` in the text stays literal. An
 * unpaired `**` is kept as plain text.
 */
export function boldRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const push = (t: string, bold: boolean) => {
    if (!t) return;
    const last = runs[runs.length - 1];
    if (last && last.bold === bold) last.text += t;
    else runs.push({ text: t, bold });
  };
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("**", i);
    if (open === -1) break;
    const close = text.indexOf("**", open + 2);
    if (close === -1) break;
    if (close === open + 2) {
      // "****": nothing to embolden; keep it as written.
      push(text.slice(i, close + 2), false);
      i = close + 2;
      continue;
    }
    push(text.slice(i, open), false);
    push(text.slice(open + 2, close), true);
    i = close + 2;
  }
  push(text.slice(i), false);
  return runs;
}

/** Which card statuses get a one-line note above the buttons. */
export function statusNote(status: CardStatus): string | null {
  switch (status) {
    case "paused": return "this meetup is paused right now. you can still read the card.";
    case "full": return "this meetup is full right now. you can still read the card.";
    case "not_open_yet": return "this meetup hasn't opened yet. you can read the card and get ready early.";
    case "closed": return "this meetup has closed.";
    default: return null;
  }
}

// ---- The acknowledgement, kept for this tab (it survives the Stripe round trip) ----

export const ACK_KEY = "ri_meetup_ack";
const PASS_KEY = "ri_stranger_pass";

export interface StoredAck {
  ackToken: string;
  version: number;
  /** "get ready early": stop after the age check, even after coming back from Stripe. */
  prepareOnly?: boolean;
}

interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function session(): KV | null {
  try {
    const s = (globalThis as { sessionStorage?: KV }).sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function saveAck(ack: StoredAck, store: KV | null = session()): void {
  try { store?.setItem(ACK_KEY, JSON.stringify(ack)); } catch { /* private window */ }
}

export function loadAck(store: KV | null = session()): StoredAck | null {
  try {
    const raw = store?.getItem(ACK_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredAck>;
    if (typeof v.ackToken !== "string" || !v.ackToken || typeof v.version !== "number") return null;
    return { ackToken: v.ackToken, version: v.version, ...(v.prepareOnly ? { prepareOnly: true } : {}) };
  } catch {
    return null;
  }
}

export function clearAck(store: KV | null = session()): void {
  try { store?.removeItem(ACK_KEY); } catch { /* private window */ }
}

/** The stranger pass, when this tab already has one (re-acks bind to it at once). */
export function currentStrangerPass(store: KV | null = session()): string | null {
  try { return store?.getItem(PASS_KEY) ?? null; } catch { return null; }
}

/** The body for POST /events/ack: the pass only when there is one. */
export function ackBody(meetup: string, cardVersion: number, pass: string | null): { meetup: string; cardVersion: number; pass?: string } {
  return pass ? { meetup, cardVersion, pass } : { meetup, cardVersion };
}

// ---- Leaving the meetup ----

/**
 * The same address without `meetup` (path, other params and hash kept), for
 * history.replaceState before an invite game or solo play. Returns null when
 * there was no meetup to remove.
 */
export function urlWithoutMeetup(href: string): string | null {
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (!url.searchParams.has("meetup")) return null;
  url.searchParams.delete("meetup");
  const q = url.searchParams.toString();
  return `${url.pathname}${q ? `?${q}` : ""}${url.hash}`;
}

/**
 * The next lower level an event may drop to after the first acknowledgement
 * (spec §9.1): an outside event steps 3 → 1 → 0; a studio event is 0 or 3.
 */
export function lowerLevel(kind: "studio" | "outside", level: number): number | null {
  if (kind === "studio") return level === 3 ? 0 : null;
  if (level === 3) return 1;
  if (level === 1) return 0;
  return null;
}
