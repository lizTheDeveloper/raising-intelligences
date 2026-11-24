/**
 * Meetup host tools, the host portal (spec §4, build plan B.4/B.5): the shapes
 * the portal reads from /api/host/* and /api/events/deck, and the lines it
 * builds from them.
 *
 * Pure and DOM-free so it runs under `node --test`. Nothing here tracks
 * anything. A host only ever sees status, bands and proportions; this module
 * never turns any of them into a number.
 */

export type HostEventStatus = "open" | "paused" | "closed" | "full" | "not_open_yet";

export type PublishedFunnel =
  | { tooSmall: true }
  | { tooSmall: false; joined: string; started: string; finished: string; swapped: string | null };

export interface HostEv {
  ref: string;
  role: "host";
  name: string;
  level: number;
  status: HostEventStatus;
  opensAt: number;
  closesAt: number;
  shareCodes: boolean;
  /** Absent: this level never shows numbers. null: not published yet. */
  funnel?: PublishedFunnel | null;
}

export interface GuestEv {
  ref: string;
  role: "guest";
  name: string;
  opensAt: number;
  closesAt: number;
}

export type PortalEvent = HostEv | GuestEv;

export interface PortalEvents {
  displayName: string;
  events: PortalEvent[];
}

export interface Deck {
  title: string;
  intro: string;
  questions: string[];
}

const STATUSES: readonly string[] = ["open", "paused", "closed", "full", "not_open_yet"];

const isStr = (v: unknown): v is string => typeof v === "string";
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function asFunnel(v: unknown): PublishedFunnel | null | undefined | false {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isRec(v)) return false;
  if (v.tooSmall === true) return { tooSmall: true };
  if (v.tooSmall !== false) return false;
  if (!isStr(v.joined) || !isStr(v.started) || !isStr(v.finished)) return false;
  if (v.swapped !== null && !isStr(v.swapped)) return false;
  return { tooSmall: false, joined: v.joined, started: v.started, finished: v.finished, swapped: v.swapped as string | null };
}

function asEvent(v: unknown): PortalEvent | null {
  if (!isRec(v)) return null;
  if (!isStr(v.ref) || !v.ref || !isStr(v.name) || !isTime(v.opensAt) || !isTime(v.closesAt)) return null;
  if (v.role === "guest") return { ref: v.ref, role: "guest", name: v.name, opensAt: v.opensAt, closesAt: v.closesAt };
  if (v.role !== "host") return null;
  if (!isStr(v.status) || !STATUSES.includes(v.status)) return null;
  if (typeof v.level !== "number" || !Number.isInteger(v.level)) return null;
  const funnel = asFunnel(v.funnel);
  if (funnel === false) return null;
  return {
    ref: v.ref,
    role: "host",
    name: v.name,
    level: v.level,
    status: v.status as HostEventStatus,
    opensAt: v.opensAt,
    closesAt: v.closesAt,
    shareCodes: v.shareCodes === true,
    ...(funnel === undefined ? {} : { funnel }),
  };
}

/** The /host/events body, or null when it isn't one. Malformed entries are dropped, not guessed at. */
export function asPortalEvents(v: unknown): PortalEvents | null {
  if (!isRec(v) || !Array.isArray(v.events)) return null;
  const events: PortalEvent[] = [];
  for (const e of v.events) {
    const ev = asEvent(e);
    if (ev) events.push(ev);
  }
  return { displayName: isStr(v.displayName) ? v.displayName : "", events };
}

/** The /events/deck body's deck, or null (host tools are off, or it isn't one). */
export function asDeck(v: unknown): Deck | null {
  if (!isRec(v) || !isRec(v.deck)) return null;
  const d = v.deck;
  if (!isStr(d.title) || !isStr(d.intro) || !Array.isArray(d.questions) || !d.questions.every(isStr)) return null;
  if (d.questions.length === 0) return null;
  return { title: d.title, intro: d.intro, questions: [...d.questions] };
}

// ---- Lines ----

/** "november 20, 2026", in local time unless a zone is given (tests). */
export function formatDate(ms: number, timeZone?: string): string {
  return new Date(ms)
    .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", ...(timeZone ? { timeZone } : {}) })
    .toLowerCase();
}

/** "november 20, 2026" for a one-day meetup, else "november 20, 2026 – november 22, 2026". */
export function dateRange(opensAt: number, closesAt: number, timeZone?: string): string {
  const a = formatDate(opensAt, timeZone);
  const b = formatDate(closesAt, timeZone);
  return a === b ? a : `${a} – ${b}`;
}

/** How a status reads after the event name. */
export function statusLabel(s: HostEventStatus): string {
  return s === "not_open_yet" ? "not open yet" : s;
}

export const NUMBERS_LATER =
  "while your meetup is open you'll only see whether it's open, paused, closed or full. numbers, if there are any, appear a day after it closes.";
export const TOO_SMALL = "this meetup was too small to show numbers.";

/**
 * The published numbers as one line, or null when there is nothing published
 * to show (no numbers at this level, or not published yet).
 */
export function funnelLine(funnel: PublishedFunnel | null | undefined): string | null {
  if (!funnel) return null;
  if (funnel.tooSmall) return TOO_SMALL;
  const parts = [
    `joined the queue: ${funnel.joined}`,
    `games started: ${funnel.started}`,
    `games finished: ${funnel.finished}`,
  ];
  if (funnel.swapped !== null) parts.push(`pairs who swapped handles: ${funnel.swapped}`);
  return parts.join(" · ");
}

/** Which controls a host event shows. A closed event shows none. */
export function hostActions(e: HostEv): { toggle: "pause" | "resume" | null; close: boolean; lower: boolean } {
  if (e.status === "closed") return { toggle: null, close: false, lower: false };
  return { toggle: e.status === "paused" ? "resume" : "pause", close: true, lower: e.level > 0 };
}

/** The share codes section: anyone who hosts a code event, or reads as a guest anywhere. */
export function showShareCodes(events: PortalEvent[]): boolean {
  return events.some((e) => e.role === "guest" || e.shareCodes);
}

// ---- The host pass, kept for this tab ----

export const HOST_PASS_KEY = "ri_host_pass";

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

export function loadHostPass(store: KV | null = session()): string | null {
  try { return store?.getItem(HOST_PASS_KEY) || null; } catch { return null; }
}

export function saveHostPass(pass: string | null, store: KV | null = session()): void {
  try {
    if (pass) store?.setItem(HOST_PASS_KEY, pass);
    else store?.removeItem(HOST_PASS_KEY);
  } catch { /* private window */ }
}

/** `?host=1` opens the portal, `?deck=1` the deck alone; anything else is the normal app. */
/** "multiversegames.ai/raising-intelligences": the game's address, for print. */
export function gameAddress(origin: string, base: string): string {
  return `${origin.replace(/^https?:\/\//, "")}${base}`.replace(/\/+$/, "");
}

/** The deck's "to play" block: where the game is and how two people start (persona tests, finding 10). */
export function deckPlayLines(address: string): { heading: string; steps: string[] } {
  return {
    heading: "to play",
    steps: [
      `open ${address} on a phone or laptop.`,
      `to play together, choose "play with a partner" and send the other person the link it gives you. to play alone, choose "play solo".`,
    ],
  };
}

export function hostRoute(search: string): "host" | "deck" | null {
  const p = new URLSearchParams(search);
  if (p.get("host") === "1") return "host";
  if (p.get("deck") === "1") return "deck";
  return null;
}
