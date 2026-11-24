import type { EventStatus, FrozenTerms, HostEvent, HostPerson } from "./types.js";

/**
 * The event card (spec §3). Every line is built here, on the server, so the
 * copy has one source, can be tested, and can be stored exactly as a player
 * accepted it. Lower-case and plain, like the shipped stranger screens.
 */

export interface LiveSettings {
  /** RI_PARTNER_PAYWALL is charging right now. */
  paywallOn: boolean;
  traceRetentionDays: number | null;
  traceWhere: "studio" | "langfuse_cloud";
}

export interface CardSection {
  heading?: string;
  paragraphs?: string[];
  bullets?: string[];
}

export interface CardPayload {
  version: number;
  prototype: true;
  eventName: string;
  status: EventStatus;
  lead: string;
  hostLine: string;
  welcome: string;
  sections: CardSection[];
  /** "came with someone you know?" */
  invite: string;
  /** The "not for me" screen. */
  notForMe: string[];
  conductUrl: string | null;
  /** The name used for "report this host"; null at a studio event with no guest. */
  hostName: string | null;
  shareCodes: boolean;
}

/** Draft wording, for Liz's spoiler review (spec §13.4b). */
export const CONTENT_NOTES =
  "family arguments, a child who lies and keeps secrets, school trouble, illness, grief, and teenage risk-taking. if a child is treated cruelly, the story can bring in outside help.";

/** The terms a card would freeze if it were acknowledged now. */
export function liveTerms(event: HostEvent, live: LiveSettings): FrozenTerms {
  return {
    cost: live.paywallOn ? "first_parent" : "free",
    traceRetentionDays: live.traceRetentionDays,
    traceWhere: live.traceWhere,
    handleExchange: event.handleExchange,
    learning: event.kind === "studio" && event.studioLearning,
  };
}

/** The terms the card shows: frozen once anyone has acknowledged it. */
export function termsFor(event: HostEvent, live: LiveSettings): FrozenTerms {
  return event.frozenTerms ?? liveTerms(event, live);
}

/**
 * A studio-wide setting changed while an event is open (H17). The event keeps
 * its card's terms; a change in the player's favour applies at once (a new
 * card version); a change that can't be honoured closes the event.
 */
export function reconcileTerms(frozen: FrozenTerms, live: LiveSettings):
  | { action: "keep" }
  | { action: "update"; terms: FrozenTerms }
  | { action: "close"; reason: string } {
  // Traces: kept for fewer days is in the player's favour; longer, or a purge
  // that stopped running, can't be honoured. So can't traces moving off the studio's servers.
  if (frozen.traceWhere === "studio" && live.traceWhere !== "studio") return { action: "close", reason: "traces moved to a provider" };
  const f = frozen.traceRetentionDays;
  const l = live.traceRetentionDays;
  if (f !== null && (l === null || l > f)) return { action: "close", reason: "trace retention got longer" };
  let terms = frozen;
  if (l !== null && (f === null || l < f)) terms = { ...terms, traceRetentionDays: l };
  if (frozen.traceWhere !== "studio" && live.traceWhere === "studio") terms = { ...terms, traceWhere: "studio" };
  // Cost: a "free" card stays free whatever the paywall does now (the opening
  // gate honours it). A paid card becomes free if the paywall is switched off.
  if (frozen.cost === "first_parent" && !live.paywallOn) terms = { ...terms, cost: "free" };
  return terms === frozen ? { action: "keep" } : { action: "update", terms };
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export function cardDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** The role line is shown only if Liz checked it and recorded what she checked (H16). */
export function roleShown(p: HostPerson): string | null {
  return p.roleText && p.roleChecked && p.roleCheckedAt ? p.roleText : null;
}

const COST_LINE = {
  free: "it's free at this meetup.",
  first_parent: "$20 per child, paid once by whoever is paired first, and only after your co-parent arrives. nobody pays for a no-show.",
} as const;

export function traceLine(t: FrozenTerms): string {
  const where = t.traceWhere === "studio" ? "on the studio's own servers" : "with Langfuse, our tracing provider";
  return t.traceRetentionDays !== null
    ? `it's kept ${where} for ${t.traceRetentionDays} days, then deleted.`
    : `it's kept ${where} until the studio deletes it, and there's no way yet to ask for that. taking a game off your account (on your account page) takes your name off your co-parent's copy, but deletes neither the game nor this record.`;
}

const LEARNING_LINE = {
  studio: "if you both say so at the end, the studio may read your game to improve stranger mode. it's never published or used to train AI. if either of you says no, it isn't read for that.",
  never: "games from this meetup are never used in the studio's blog posts, research or AI training.",
};

/** Coming to a meetup is itself a record (attendance can be sensitive: a faith or health group). */
export const ATTENDANCE_LINE =
  "the studio records that your account came to this meetup, and which card you agreed to, until a year after the meetup closes. \"remove from my list\" on your account page deletes that record sooner. a game you play here is a separate record.";

const HANDLE_LINE = {
  on: "if you both say yes, you'll each see the other's Matrix handle (not a phone number or email). if either says no, nothing is shared.",
  off: "there's no contact swap at this meetup.",
};

export const STUDIO_BLOCK =
  "this meetup is run by the studio that makes the game. the studio holds your game the way it holds every game: to run it, keep it safe and review reports. nobody outside the studio sees it.";

export function l0Block(host: string): string[] {
  return [`${host} can't see anything about you or your game. they only know whether the meetup is open.`];
}

export function l1Block(host: string): string[] {
  return [
    `${host} sees only rough totals for the whole meetup, a day after it closes: about how many people joined and how many games started, in ranges like "10–19", and, if at least 10 games started, whether more or less than half finished and swapped handles. if fewer than 5 games started, ${host} sees nothing at all.`,
    `${host} can't see who you were paired with, anything in your game, or what you said yes or no to. in a small room people may notice who left early. RI never tells ${host} why.`,
  ];
}

export function l3Block(host: string): string[] {
  return [
    `${host} only sees your game if **you two** give them a share code. at the end you'll each be asked, on your own, and you'll see exactly what it shows first. if you both say yes, a code appears on your account page, and you decide whether and when to give it to ${host}. ${host} can open a code for 14 days after it appears, then read it for 30 days after opening it.`,
    `RI never gives ${host} a list of who played or who made a code. but ${host} may know you came, and may notice that no code came from your pair. they can't tell why. games end up without a code when they don't finish, when either of you says no or waits, when you keep the code to yourselves, or for reasons RI doesn't share.`,
    `a code shows: your report card (without its quotes) and your child's epilogue. both were written from your whole game, including your private talks with your child. they don't show those talks, but they can reflect them. you'll read exactly what ${host} would see before you choose.`,
    "if you both say yes but no code appears, your game couldn't make one. RI doesn't say why.",
    `you can stop a code from your account page at any time. that stops ${host} opening it again; it can't make ${host} forget what they've already read. if you stop it, ${host} will see that it no longer opens, and might say so in front of your co-parent.`,
  ];
}

export function guestBlock(guest: HostPerson): string[] {
  const role = roleShown(guest);
  const name = guest.displayName;
  const roleClause = role ? `, ${role}, checked by the studio on ${cardDate(guest.roleCheckedAt!)}` : "";
  return [
    STUDIO_BLOCK,
    `${name}${roleClause} is a guest at this meetup. if you both want to talk your game through with ${name}, you can make a share code for ${name}. ${name} sees nothing else about this meetup.`,
    ...l3Block(name),
  ];
}

/** When the admin recorded who promoted the meetup: they're kept out of the queue (H12) and see nothing. */
export const PROMOTER_LINE = "the business or group that sent you this link can't play at this meetup, and sees nothing about who came or how it went.";

/** The "who sees what" level block (spec §3.4). */
export function levelBlock(event: HostEvent, host: HostPerson | null, guest: HostPerson | null): string[] {
  if (event.kind === "studio") return guest && event.level === 3 ? guestBlock(guest) : [STUDIO_BLOCK];
  const name = host?.displayName ?? "the host";
  if (event.level === 0) return l0Block(name);
  if (event.level === 1) return l1Block(name);
  return [...l1Block(name), ...l3Block(name)];
}

export function inviteCostClause(paywallOn: boolean): string {
  return paywallOn ? "it's $20 per child, paid by whoever starts it, once the other person joins." : "it's free.";
}

export function notForMeLines(paywallOn: boolean): string[] {
  const clause = paywallOn
    ? ". raising one with someone you invite is $20 per child, paid by whoever starts it, once they join"
    : ", or with someone you invite, also free";
  return ["that's fine. nothing about this is counted or passed on.", `you can raise a child on your own, free${clause}.`];
}

export function buildCard(input: {
  event: HostEvent;
  terms: FrozenTerms;
  host: HostPerson | null;
  guest: HostPerson | null;
  paywallOn: boolean;
  status: EventStatus;
}): CardPayload {
  const { event, terms, host, guest, paywallOn, status } = input;
  const person = event.kind === "outside" ? host : event.level === 3 ? guest : null;
  const name = person?.displayName ?? null;
  const lead = name
    ? `the studio is testing new host tools with real people. the studio made this meetup and checked ${name} itself. everything below is exactly what happens. if anything changes, you'll see a new card first.`
    : "the studio is testing new host tools with real people. the studio made this meetup. everything below is exactly what happens. if anything changes, you'll see a new card first.";
  const hostLine = event.kind === "studio"
    ? "run by the studio that makes raising intelligences."
    : `hosted by ${name ?? "the host"} · ID-checked host, approved by the studio`;
  const play = "you'll raise one child from birth to 25 with one other adult at this meetup. you won't know who until you're in the game, and you'll only see each other's choices as parents.";
  const asks = [
    "a multiversegames.ai (Matrix) account.",
    "a photo ID and a live selfie, checked by Stripe, to prove you're 18 or over. we keep only \"18+: yes\" and a coded fingerprint of your document number, so one ID can't open two accounts. Stripe deletes the check once we have the answer, apart from what the law makes it keep.",
    event.lengthText ? `about ${event.lengthText}. ${play}` : play,
    COST_LINE[terms.cost],
  ];
  const privacy = name
    ? `your age check, your ID and your Matrix account are never shown to ${name}. if you report someone, the report goes to the studio, not to ${name}, and ${name} isn't told.`
    : "your age check, your ID and your Matrix account are never shown to anyone at this meetup. if you report someone, the report goes to the studio.";
  const keeps = [
    "the game runs on the studio's servers. what you type is sent to AI providers, through OpenRouter, to write your child's replies. they don't get your name or your ID.",
    `the studio keeps a technical record of every game, including private talks, to fix problems and review reports. ${traceLine(terms)}`,
    terms.learning ? LEARNING_LINE.studio : LEARNING_LINE.never,
    ATTENDANCE_LINE,
    "the studio counts, without cookies, how many people reach each step of stranger mode, across all meetups. nothing on this page is counted.",
  ];
  const who = name ? `${name} sees nothing about it` : "nobody at this meetup sees anything about it";
  return {
    version: event.cardVersion,
    prototype: true,
    eventName: event.name,
    status,
    lead,
    hostLine,
    welcome: event.welcomeText,
    sections: [
      { heading: "what this asks of you", bullets: asks },
      { heading: "what's in the game", paragraphs: [CONTENT_NOTES] },
      {
        heading: "who sees what",
        paragraphs: [
          ...levelBlock(event, host, guest),
          ...((event.promoterIds ?? []).length ? [PROMOTER_LINE] : []),
          "your co-parent sees everything the two of you do together, and can tell anyone about it. no other player and no host ever sees your private talks with your child, though your child may bring up what you told them.",
          privacy,
        ],
      },
      { heading: "what the studio keeps", bullets: keeps },
      { heading: "at the end", paragraphs: [terms.handleExchange ? HANDLE_LINE.on : HANDLE_LINE.off] },
    ],
    invite: `you can raise a child together as an ordinary invite game instead. it isn't part of this meetup: ${who} and there's no ID check. the stranger protections (reports to the studio, blocks) don't cover invite games, so only do this with someone you already know. ${inviteCostClause(paywallOn)} invite prices can change.`,
    notForMe: notForMeLines(paywallOn),
    conductUrl: event.conductUrl,
    hostName: name,
    shareCodes: event.shareCodes && event.level === 3,
  };
}
