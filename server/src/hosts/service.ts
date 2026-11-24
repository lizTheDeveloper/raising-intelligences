import { markGameHosted } from "../observability/hosted-analysis.js";
import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { normalizeMeetupCode, readStrangerConfig } from "../stranger/config.js";
import type { StrangerService, StrangerHostTools } from "../stranger/service.js";
import type { PartnerPayments } from "../payments/partner-payments.js";
import { buildCard, liveTerms, reconcileTerms, termsFor, type CardPayload, type LiveSettings } from "./card.js";
import { ackTokenHash, deriveEventCode, eventCodeHash, newAckToken, opaqueRef, shareCodeHash } from "./codes.js";
import { MAX_EVENT_MS, readHostToolsConfig, type HostToolsConfig } from "./config.js";
import type { HostStore, PurgeRules } from "./store.js";
import { HOST_TYPES, type EventStatus, type HostEvent, type HostPerson, type HostType, type Level } from "./types.js";

export interface HostToolsDeps {
  store: HostStore;
  stranger: StrangerService;
  payments: PartnerPayments;
  config: () => HostToolsConfig;
  /** RI_STRANGER_PEPPER: keys every hash here, as it keys stranger subjects. */
  pepper: string;
  /** Codes listed in RI_MEETUP_CODES: kept as studio L0 events. */
  envCodes?: Iterable<string>;
  now?: () => number;
}

export interface EventInput {
  name: string;
  kind: "studio" | "outside";
  hostPersonId?: string | null;
  guestReaderId?: string | null;
  sensitive?: boolean;
  authority?: boolean;
  eventsBusiness?: boolean;
  level: Level;
  studioLearning?: boolean;
  handleExchange?: boolean;
  welcomeText?: string;
  lengthText?: string | null;
  conductUrl?: string | null;
  capacity?: number;
  joinWindowMs?: number;
  opensAt: number;
  closesAt: number;
}

export type AdminResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const NEUTRAL_REFUSAL = "stranger mode isn't available here.";
export const CARD_CHANGED = "this meetup's card changed. here's the new one.";
const ENV_EVENT_NAME = "a studio meetup";

/**
 * The host tools prototype, server side: events (from the admin, and the
 * RI_MEETUP_CODES list), the event card and its acknowledgement, the frozen
 * terms, and the queue's checks. Events are held in memory as well as the
 * store (one process), so "is this meetup code visible?" stays synchronous,
 * as stranger mode needs it to be.
 */
const DAY_MS = 24 * 3600_000;

/**
 * Retention (spec §10). The spec keeps frozen terms and the published funnel
 * for a year; the acknowledgement that a player saw that card is kept as long.
 * A share code's row and access log go 30 days after it stops opening (its
 * snapshot is cleared the moment it stops). A done unlink request is kept a
 * year, so a report filed after the unlink still reaches the right account.
 */
export const PURGE_RULES: PurgeRules = {
  ackAfterCloseMs: 365 * DAY_MS,
  eventRecordsAfterCloseMs: 365 * DAY_MS,
  codeAfterLiveMs: 30 * DAY_MS,
  unlinkDoneMs: 365 * DAY_MS,
};

export class HostTools implements StrangerHostTools {
  readonly store: HostStore;
  readonly stranger: StrangerService;
  readonly payments: PartnerPayments;
  readonly config: () => HostToolsConfig;
  private readonly pepper: string;
  private readonly envCodes: string[];
  private readonly nowFn: () => number;
  private byHash = new Map<string, HostEvent>();
  private byId = new Map<string, HostEvent>();
  private loaded = false;
  readonly ready: Promise<void>;

  constructor(deps: HostToolsDeps) {
    this.store = deps.store;
    this.stranger = deps.stranger;
    this.payments = deps.payments;
    this.config = deps.config;
    this.pepper = deps.pepper;
    this.envCodes = [...(deps.envCodes ?? [])].map((c) => normalizeMeetupCode(c)).filter((c): c is string => !!c);
    this.nowFn = deps.now ?? Date.now;
    this.ready = this.init().catch((err) => {
      logger.error("host_tools_init_failed", { error: err instanceof Error ? err.message : String(err) });
    });
  }

  static fromEnv(deps: Omit<HostToolsDeps, "config" | "pepper" | "envCodes">, env: NodeJS.ProcessEnv = process.env): HostTools {
    const cfg = readHostToolsConfig(env);
    return new HostTools({
      ...deps,
      config: () => cfg,
      pepper: env.RI_STRANGER_PEPPER ?? "",
      envCodes: readStrangerConfig(env).meetupCodes,
    });
  }

  now(): number {
    return this.nowFn();
  }

  /** On in meetup mode only (and only once stranger mode itself is on). */
  active(): boolean {
    return this.config().enabled && this.stranger.config().mode === "meetup";
  }

  live(): LiveSettings {
    const c = this.config();
    return { paywallOn: this.payments.active(), traceRetentionDays: c.traceRetentionDays, traceWhere: c.traceWhere };
  }

  // ---- The registry ----

  private remember(e: HostEvent | null): HostEvent | null {
    if (!e) return null;
    const prior = this.byId.get(e.id);
    if (prior && prior.codeHash !== e.codeHash) this.byHash.delete(prior.codeHash);
    this.byId.set(e.id, e);
    this.byHash.set(e.codeHash, e);
    return e;
  }

  /** Display names of hosts and guest readers, for the end screens (sync). */
  private names = new Map<string, string>();

  private async init(): Promise<void> {
    for (const e of await this.store.listEvents()) this.remember(e);
    for (const p of await this.store.listPeople()) this.names.set(p.id, p.displayName);
    // Before any play resumes: every game at an event is tagged in Langfuse (H18), whatever the mode now.
    await this.markHostedGames();
    if (this.active()) {
      await this.syncEnvEvents();
      await this.reconcileAll();
      // A period can end between card reads: roll it then, too.
      setInterval(() => {
        if (this.active() && this.envPeriodOver()) void this.syncEnvEvents().catch(() => {});
      }, 5 * 60_000).unref();
    }
    this.loaded = true;
  }

  /** Runs the §10 retention schedule (POST /api/admin/host-tools/purge). Counts only. */
  async purge(): Promise<Record<string, number>> {
    return this.store.purge(this.now(), PURGE_RULES);
  }

  /** Tags every game at every event as hosted, in this process (boot, after a restart). */
  async markHostedGames(): Promise<void> {
    for (const e of this.byId.values()) {
      for (const r of await this.stranger.store.runsForEvent(e.id)) markGameHosted(r.gameId);
    }
  }

  private syncing: Promise<void> | null = null;

  /**
   * RI_MEETUP_CODES: each listed code is a studio L0 event, one 14-day period
   * at a time. When a period ends, its event is retired (its row keeps the
   * terms it froze, so every game started under them keeps them) and the code
   * opens a new period: a fresh event, a fresh card, and terms frozen afresh
   * at the next acknowledgement. Runs at start and, lazily, on card reads.
   */
  async syncEnvEvents(): Promise<void> {
    if (!this.syncing) this.syncing = this.doSyncEnvEvents().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private envPeriodOver(): boolean {
    const now = this.now();
    for (const c of this.envCodes) {
      const e = this.byHash.get(eventCodeHash(this.pepper, c));
      if (!e || (e.source === "env" && e.closedAt === null && now >= e.closesAt)) return true;
    }
    return false;
  }

  private async doSyncEnvEvents(): Promise<void> {
    const now = this.now();
    const listed = new Set(this.envCodes.map((c) => eventCodeHash(this.pepper, c)));
    for (const hash of listed) {
      const existing = this.byHash.get(hash);
      if (existing && existing.source !== "env") continue; // an admin event already uses this code
      if (existing) {
        if (existing.closedAt !== null) continue; // closed by the admin: stays closed
        if (now < existing.closesAt) continue; // still in its period: unchanged
        // Period over: retire this event under a hash no code can produce, then open a new one.
        this.remember(await this.store.updateEvent(existing.id, { codeHash: `retired:${existing.id}`, closedAt: existing.closesAt }));
        logger.info("host_env_event_new_period", { retiredEventId: existing.id });
      }
      const e: HostEvent = {
        id: randomUUID(), codeHash: hash, source: "env", name: ENV_EVENT_NAME, kind: "studio", hostPersonId: null, guestReaderId: null, promoterIds: [], codeSeq: null,
        sensitive: false, authority: false, eventsBusiness: false, level: 0, shareCodes: false, studioLearning: false, handleExchange: true,
        welcomeText: "", lengthText: null, conductUrl: null, capacity: 500, joinWindowMs: this.stranger.config().joinWindowMs,
        opensAt: now, closesAt: now + MAX_EVENT_MS, paused: false, pausedBy: null, closedAt: null, cardVersion: 1, frozenTerms: null, firstAckAt: null,
        publishedFunnel: null, publishedAt: null, createdAt: now,
      };
      await this.store.createEvent(e);
      this.remember(e);
    }
    // A code taken off the list is closed, as it was hidden before.
    for (const e of this.byId.values()) {
      if (e.source === "env" && !listed.has(e.codeHash) && e.closedAt === null) {
        this.remember(await this.store.updateEvent(e.id, { closedAt: now }));
      }
    }
  }

  /**
   * H17: a studio-wide setting changed while events were open. Each keeps its
   * card's terms; a change in the player's favour applies now (new card
   * version); one that can't be honoured closes the event.
   */
  async reconcileAll(): Promise<void> {
    const live = this.live();
    for (const e of [...this.byId.values()]) {
      if (!e.frozenTerms || this.status(e) === "closed") continue;
      const r = reconcileTerms(e.frozenTerms, live);
      if (r.action === "update") {
        this.remember(await this.store.updateEvent(e.id, { frozenTerms: r.terms, cardVersion: e.cardVersion + 1 }));
        logger.info("host_event_terms_updated", { eventId: e.id });
      } else if (r.action === "close") {
        this.remember(await this.store.updateEvent(e.id, { closedAt: this.now() }));
        logger.warn("host_event_closed_terms_changed", { eventId: e.id, reason: r.reason });
      }
    }
  }

  /** The event a meetup code opens, if any (never logged, never stored in the clear). */
  eventForCode(code: unknown): HostEvent | null {
    const c = normalizeMeetupCode(code);
    if (!c) return null;
    return this.byHash.get(eventCodeHash(this.pepper, c)) ?? null;
  }

  /** The stored hash of a share code's words. */
  shareHash(normalizedWords: string): string {
    return shareCodeHash(this.pepper, normalizedWords);
  }

  /** A per-viewer opaque reference (H11): never a raw id in a host or account response. */
  ref(kind: "game" | "code" | "event", viewer: string, id: string): string {
    return opaqueRef(this.pepper, kind, viewer, id);
  }

  /** Re-reads an event into the registry after a direct store write (the funnel's one publication). */
  refresh(e: HostEvent): void {
    this.remember(e);
  }

  eventById(id: string | null | undefined): HostEvent | null {
    return id ? this.byId.get(id) ?? null : null;
  }

  listCached(): HostEvent[] {
    return [...this.byId.values()];
  }

  /** Open, paused, closed or not open yet. "Full" needs a count: see statusNow. */
  status(e: HostEvent): EventStatus {
    const now = this.now();
    if (e.closedAt !== null || now >= e.closesAt) return "closed";
    // Fail closed: an event with share codes can't open without the secret.
    if (e.shareCodes && !this.config().shareCodeSecret) return "closed";
    if (now < e.opensAt) return "not_open_yet";
    return e.paused ? "paused" : "open";
  }

  async statusNow(e: HostEvent): Promise<EventStatus> {
    const s = this.status(e);
    if (s !== "open") return s;
    return (await this.store.countQueued(e.id)) >= e.capacity ? "full" : "open";
  }

  /** Can a visitor with this code see the meetup at all? (Not closed.) */
  codeVisible(code: unknown): boolean {
    if (!this.loaded) return false;
    const e = this.eventForCode(code);
    return !!e && this.status(e) !== "closed";
  }

  /** Is this event still running (for a game already matched at it)? */
  eventLive(eventId: string): boolean {
    const e = this.byId.get(eventId);
    return !!e && this.status(e) !== "closed";
  }

  eventIdFor(meetupCode: string | null): string | null {
    return this.eventForCode(meetupCode)?.id ?? null;
  }

  joinWindowMs(eventId: string): number | null {
    return this.byId.get(eventId)?.joinWindowMs ?? null;
  }

  // ---- The card ----

  private async people(e: HostEvent): Promise<{ host: HostPerson | null; guest: HostPerson | null }> {
    return {
      host: e.hostPersonId ? await this.store.getPerson(e.hostPersonId) : null,
      guest: e.guestReaderId ? await this.store.getPerson(e.guestReaderId) : null,
    };
  }

  async cardFor(e: HostEvent): Promise<CardPayload> {
    const live = this.live();
    const { host, guest } = await this.people(e);
    return buildCard({ event: e, terms: termsFor(e, live), host, guest, paywallOn: live.paywallOn, status: await this.statusNow(e) });
  }

  /** The card for a visible meetup code, or null (unknown, closed, off: all the same). */
  async card(code: unknown): Promise<CardPayload | null> {
    if (this.active() && this.envPeriodOver()) await this.syncEnvEvents();
    if (!this.active() || !this.codeVisible(code)) return null;
    return this.cardFor(this.eventForCode(code)!);
  }

  /**
   * "continue" on the card. Freezes the terms at the first acknowledgement
   * (one atomic write), records the card version and returns a pre-subject
   * token. A stale version gets the current card back.
   */
  async acknowledge(code: unknown, cardVersion: unknown, subject: string | null = null):
    Promise<{ ok: true; ackToken: string } | { ok: false; status: 404 } | { ok: false; status: 409; card: CardPayload }> {
    if (this.active() && this.envPeriodOver()) await this.syncEnvEvents();
    if (!this.active() || !this.codeVisible(code)) return { ok: false, status: 404 };
    let e = this.eventForCode(code)!;
    if (cardVersion !== e.cardVersion) return { ok: false, status: 409, card: await this.cardFor(e) };
    const now = this.now();
    if (!e.frozenTerms) {
      await this.store.freezeTerms(e.id, liveTerms(e, this.live()), now);
      e = this.remember(await this.store.getEvent(e.id))!;
      // A version change can't race this (only admin edits bump it, and those refuse after the first ack).
    }
    await this.store.saveCard(e.id, e.cardVersion, await this.cardFor(e));
    const token = newAckToken();
    await this.store.addAck({
      id: randomUUID(), eventId: e.id, cardVersion: e.cardVersion, preTokenHash: ackTokenHash(this.pepper, token),
      subject, at: now, boundAt: subject ? now : null, queuedAt: null, unlistedAt: null,
    });
    return { ok: true, ackToken: token };
  }

  private async ackCurrent(subject: string, e: HostEvent): Promise<boolean> {
    return (await this.store.acksForSubject(subject)).some((a) => a.eventId === e.id && a.cardVersion === e.cardVersion);
  }

  /** At stranger sign-in: bind this browser's acknowledgement to the account. */
  async bindAck(ackToken: unknown, meetupCode: string | null, subject: string): Promise<{ ok: true } | { ok: false; card: CardPayload | null }> {
    const e = this.eventForCode(meetupCode);
    if (!e) return { ok: false, card: null };
    if (typeof ackToken === "string" && ackToken.length > 0 && ackToken.length < 200) {
      const a = await this.store.ackByTokenHash(ackTokenHash(this.pepper, ackToken));
      if (a && a.eventId === e.id && a.cardVersion === e.cardVersion && (a.subject === null || a.subject === subject)) {
        if (a.subject === null) await this.store.bindAck(a.id, subject, this.now());
        return { ok: true };
      }
    }
    if (await this.ackCurrent(subject, e)) return { ok: true };
    return { ok: false, card: await this.cardFor(e) };
  }

  /** Is this subject the event's host, guest reader or a promoter (H12)? */
  async isHostOrGuest(e: HostEvent, subject: string): Promise<boolean> {
    for (const id of [e.hostPersonId, e.guestReaderId, ...(e.promoterIds ?? [])]) {
      if (!id) continue;
      const p = await this.store.getPerson(id);
      if (p && p.subject === subject) return true;
    }
    return false;
  }

  /** The queue's checks at an event (StrangerMatching.join). */
  async join(subject: string, meetupCode: string | null): Promise<{ ok: true; eventId: string; cardVersion: number } | { ok: false; status: number; error: string; card?: unknown }> {
    const e = this.eventForCode(meetupCode);
    if (!e) return { ok: false, status: 404, error: "Not found" };
    if (await this.isHostOrGuest(e, subject)) return { ok: false, status: 403, error: NEUTRAL_REFUSAL };
    if (!(await this.ackCurrent(subject, e))) return { ok: false, status: 409, error: CARD_CHANGED, card: await this.cardFor(e) };
    const s = this.status(e);
    if (s === "closed") return { ok: false, status: 404, error: "Not found" };
    if (s === "not_open_yet") return { ok: false, status: 409, error: "this meetup hasn't opened yet." };
    if (s === "paused") return { ok: false, status: 409, error: "this meetup is paused. try again in a little while." };
    if (!(await this.store.hasQueued(subject, e.id)) && (await this.store.countQueued(e.id)) >= e.capacity) {
      return { ok: false, status: 409, error: "this meetup is full." };
    }
    await this.store.markQueued(subject, e.id, this.now());
    return { ok: true, eventId: e.id, cardVersion: e.cardVersion };
  }

  /**
   * May a queued entry still be matched (synchronous, from the registry)?
   * A code that moved on to a new period, or a card version the player didn't
   * accept, is "stale": back to the card. Closed is "closed". Paused or not
   * yet open holds the entry unmatched.
   */
  entryState(eventId: string, cardVersion: number | null): "ok" | "paused" | "closed" | "stale" {
    const e = this.byId.get(eventId);
    if (!e) return "closed";
    if (e.source === "env" && (e.codeHash.startsWith("retired:") || (e.closedAt === null && this.now() >= e.closesAt))) return "stale";
    const s = this.status(e);
    if (s === "closed") return "closed";
    if (cardVersion !== null && cardVersion !== e.cardVersion) return "stale";
    if (s === "paused" || s === "not_open_yet") return "paused";
    return "ok";
  }

  /** At JOIN_GAME: the host, guest reader or a promoter never sits in a game at their own event (H12). */
  async refusedSeat(eventId: string | null | undefined, subject: string): Promise<boolean> {
    const e = this.eventById(eventId);
    return !!e && (await this.isHostOrGuest(e, subject));
  }

  /** Which end screens follow the report card in a game at this event (frozen terms). */
  endScreens(eventId: string): { handles: boolean; share: boolean; learning: boolean; host?: string } | null {
    const e = this.eventById(eventId);
    if (!e) return null;
    const t = e.frozenTerms ?? liveTerms(e, this.live());
    const readerId = e.kind === "outside" ? e.hostPersonId : e.guestReaderId;
    const host = e.shareCodes && readerId ? this.names.get(readerId) : undefined;
    return { handles: t.handleExchange, share: e.shareCodes && !!host, learning: e.kind === "studio" && t.learning, ...(host ? { host } : {}) };
  }

  handleExchangeOn(eventId: string | null | undefined): boolean {
    const e = this.eventById(eventId);
    if (!e) return true;
    return (e.frozenTerms ?? liveTerms(e, this.live())).handleExchange;
  }

  /** The opening gate: a child started at an event whose card said "free" is never charged (B6, H17). */
  async frozenFree(gameId: string): Promise<boolean> {
    const m = this.stranger.matching;
    if (!m) return false;
    const seats = await m.runFor(gameId);
    const e = this.eventById(seats?.eventId);
    return e?.frozenTerms?.cost === "free";
  }

  // ---- Admin ----

  async createPerson(input: { matrixId?: unknown; displayName?: unknown; roleText?: unknown; roleChecked?: unknown; agreementVersion?: unknown; agreementSigned?: unknown; hostType?: unknown; organisation?: unknown }): Promise<AdminResult<HostPerson>> {
    const mxid = typeof input.matrixId === "string" ? input.matrixId.trim() : "";
    if (!/^@[^:\s]+:[^\s]+$/.test(mxid)) return { ok: false, status: 400, error: "matrixId must look like @name:server" };
    const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
    if (!displayName || displayName.length > 60) return { ok: false, status: 400, error: "displayName: 1 to 60 characters" };
    const roleText = typeof input.roleText === "string" && input.roleText.trim() ? input.roleText.trim().slice(0, 80) : null;
    const roleChecked = typeof input.roleChecked === "string" && input.roleChecked.trim() ? input.roleChecked.trim().slice(0, 300) : null;
    const hostType = parseHostType(input.hostType);
    if (!hostType) return { ok: false, status: 400, error: HOST_TYPE_REQUIRED };
    const organisation = typeof input.organisation === "string" && input.organisation.trim() ? input.organisation.trim().slice(0, 60) : null;
    if (!(await this.stranger.age.adultForPool(mxid)).ok) {
      return { ok: false, status: 409, error: "This account hasn't passed the 18+ check. Send them an invite instead (Invites, below): it takes them through sign-in, the 18+ check and the host terms." };
    }
    const now = this.now();
    const p: HostPerson = {
      id: randomUUID(), subject: await this.stranger.age.subjectHash(mxid), displayName, roleText, roleChecked,
      roleCheckedAt: roleText && roleChecked ? now : null,
      // An agreement is on record only when the admin says one was signed (S2-5);
      // otherwise the portal asks the person to agree before it opens.
      ...(input.agreementSigned === true
        ? { agreementVersion: typeof input.agreementVersion === "string" && input.agreementVersion.trim() ? input.agreementVersion.trim().slice(0, 40) : this.config().agreementVersion, agreementAt: now }
        : { agreementVersion: null, agreementAt: null }),
      status: "approved", createdAt: now, hostType, organisation,
    };
    if (!(await this.store.createPerson(p))) return { ok: false, status: 409, error: "This account is already a host or guest reader." };
    this.names.set(p.id, p.displayName);
    logger.info("host_person_created", { id: p.id });
    return { ok: true, value: p };
  }

  /**
   * The host type, set once. A person from before host types (null) gets one
   * here; after that it changes only while they're on no event that is still
   * running, so no live event's ceiling shifts under it.
   */
  /** A person from an accepted invite: adult checked, terms agreed just now. */
  async createInvitedPerson(mxid: string, invite: { displayName: string; hostType: HostType; organisation: string | null }, termsVersion: string): Promise<HostPerson | null> {
    const now = this.now();
    const p: HostPerson = {
      id: randomUUID(), subject: await this.stranger.age.subjectHash(mxid), displayName: invite.displayName, roleText: null, roleChecked: null,
      roleCheckedAt: null, agreementVersion: termsVersion, agreementAt: now, status: "approved", createdAt: now,
      hostType: invite.hostType, organisation: invite.organisation,
    };
    if (!(await this.store.createPerson(p))) return null;
    this.names.set(p.id, p.displayName);
    logger.info("host_person_created", { id: p.id, via: "invite" });
    return p;
  }

  /** The person agrees to the current terms in the portal. */
  async agree(person: HostPerson, version: string): Promise<void> {
    await this.store.updatePerson(person.id, { agreementVersion: version, agreementAt: this.now() });
  }

  async setPersonType(id: string, input: { hostType?: unknown; organisation?: unknown }): Promise<AdminResult<HostPerson>> {
    const hostType = parseHostType(input.hostType);
    if (!hostType) return { ok: false, status: 400, error: HOST_TYPE_REQUIRED };
    const p = await this.store.getPerson(id);
    if (!p) return { ok: false, status: 404, error: "No such person" };
    if (p.hostType !== null && p.hostType !== hostType) {
      const live = this.listCached().some((e) => this.status(e) !== "closed" && [e.hostPersonId, e.guestReaderId, ...(e.promoterIds ?? [])].includes(id));
      if (live) return { ok: false, status: 409, error: "a host type is set once. it can change only when they're on no meetup that's still running." };
    }
    const organisation = typeof input.organisation === "string" ? (input.organisation.trim().slice(0, 60) || null) : p.organisation;
    await this.store.updatePerson(id, { hostType, organisation });
    return { ok: true, value: { ...p, hostType, organisation } };
  }

  async setPersonStatus(id: string, status: unknown): Promise<AdminResult<HostPerson>> {
    if (status !== "approved" && status !== "suspended" && status !== "closed") return { ok: false, status: 400, error: "status: approved, suspended or closed" };
    const p = await this.store.getPerson(id);
    if (!p) return { ok: false, status: 404, error: "No such person" };
    await this.store.updatePerson(id, { status });
    return { ok: true, value: { ...p, status } };
  }

  /** §9.1 ceilings and the event rules. The database enforces the same again. */
  private validate(e: HostEvent, people: Map<string, HostPerson>): string | null {
    if (!e.name.trim() || e.name.length > 60) return "name: 1 to 60 characters";
    if (e.welcomeText.length > 600) return "welcomeText: 600 characters at most";
    if (e.lengthText !== null && e.lengthText.length > 60) return "lengthText: 60 characters at most";
    if (e.conductUrl !== null && !/^https:\/\/\S+$/.test(e.conductUrl)) return "conductUrl must be an https URL";
    if (!Number.isInteger(e.capacity) || e.capacity < 1 || e.capacity > 500) return "capacity: 1 to 500";
    if (!Number.isInteger(e.joinWindowMs) || e.joinWindowMs <= 0) return "joinWindowMs must be a positive whole number";
    if (!Number.isFinite(e.opensAt) || !Number.isFinite(e.closesAt) || e.closesAt <= e.opensAt) return "closesAt must be after opensAt";
    if (e.closesAt - e.opensAt > MAX_EVENT_MS) return "an event ends within 14 days of opening";
    if (![0, 1, 3].includes(e.level)) return "level: 0, 1 or 3";
    if (e.sensitive) {
      return e.kind === "studio"
        ? "a studio event can't be for a sensitive community yet (Q4). leave this unticked if the event is open to anyone, and make the community's member a guest reader."
        : "a sensitive community can't host (Q4); its member can be a guest reader at a studio event";
    }
    if (e.eventsBusiness && e.kind === "outside") return "a dating or events business can't host until Q8a; it can promote a studio event";
    if (e.eventsBusiness && e.handleExchange) return "the handle exchange is off at an event a dating or events business promotes";
    if (e.authority && e.level === 3) return "a host with authority over attendees gets L1 at most, never share codes";
    if (e.kind === "studio") {
      if (e.hostPersonId) return "a studio event has no outside host";
      if (e.level === 1) return "a studio event is level 0, or 3 with a guest reader";
      if (e.level === 3 && !e.guestReaderId) return "share codes at a studio event need a guest reader";
      if (e.level === 0 && e.guestReaderId) return "a guest reader comes with share codes (level 3)";
    } else {
      if (!e.hostPersonId) return "an outside event needs its host";
      if (e.guestReaderId) return "guest readers are for studio events";
      if (e.studioLearning) return "studio learning is for studio events only (H18)";
    }
    if (e.hostPersonId && e.hostPersonId === e.guestReaderId) return "host and guest reader must differ";
    const promoters = e.promoterIds ?? [];
    if (promoters.length > 10) return "at most 10 promoters";
    for (const id of [e.hostPersonId, e.guestReaderId, ...promoters]) {
      if (!id) continue;
      const p = people.get(id);
      if (!p) return "no such host, guest reader or promoter";
      if (p.status !== "approved") return "that host, guest reader or promoter isn't approved";
    }
    if (promoters.some((id) => id === e.hostPersonId || id === e.guestReaderId)) return "a promoter can't also host or read for the same event";
    return this.validateTypes(e, people);
  }

  /** §9.1 from the person (persona tests, Dev): the ceiling can't be forgotten on an event. */
  private validateTypes(e: HostEvent, people: Map<string, HostPerson>): string | null {
    const host = e.hostPersonId ? people.get(e.hostPersonId) : undefined;
    const guest = e.guestReaderId ? people.get(e.guestReaderId) : undefined;
    const promoters = (e.promoterIds ?? []).map((id) => people.get(id)!);
    for (const p of [host, guest, ...promoters]) {
      if (p && p.hostType === null) return `set ${p.displayName}'s host type first (people list, "set type")`;
    }
    if (host) {
      switch (host.hostType) {
        case "events_business": return "a dating or events business can't host until Q8a; it can promote a studio event";
        case "sensitive": return `${host.displayName} is a faith or sensitive-community counsellor: they can't host yet (Q4), but they can be the guest reader at a studio event`;
        case "studio": return "studio staff don't host outside events: make it a studio event";
        case "authority": if (e.level === 3) return `${host.displayName} has authority over attendees: L1 at most, never share codes`; break;
      }
    }
    if (guest && (guest.hostType === "authority" || guest.hostType === "events_business")) {
      return guest.hostType === "authority"
        ? `${guest.displayName} has authority over attendees, so can't read share codes`
        : "a dating or events business can't be a guest reader";
    }
    const business = promoters.filter((p) => p.hostType === "events_business");
    if (business.length) {
      if (e.kind !== "studio") return "a dating or events business can only promote a studio event";
      const text = `${e.name}\n${e.welcomeText}`.toLowerCase();
      for (const p of business) {
        for (const term of businessNames(p)) {
          if (text.includes(term.toLowerCase())) return `the card doesn't name a promoting business: take "${term}" out of the name and welcome text`;
        }
      }
    }
    return null;
  }

  /** The flags an event takes from its people, on top of anything ticked (never fewer). */
  private derived(e: HostEvent, people: Map<string, HostPerson>): Pick<HostEvent, "authority" | "eventsBusiness"> {
    const type = (id: string | null) => (id ? people.get(id)?.hostType ?? null : null);
    return {
      authority: e.authority || type(e.hostPersonId) === "authority",
      eventsBusiness: e.eventsBusiness || (e.promoterIds ?? []).some((id) => type(id) === "events_business"),
    };
  }

  private async peopleMap(): Promise<Map<string, HostPerson>> {
    return new Map((await this.store.listPeople()).map((p) => [p.id, p]));
  }

  async createEvent(input: Record<string, unknown>): Promise<AdminResult<{ event: HostEvent; code: string }>> {
    if (!this.active()) return { ok: false, status: 503, error: "host tools are off (RI_STRANGER_MODE isn't meetup)" };
    const now = this.now();
    const bool = (v: unknown) => v === true;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const num = (v: unknown, d: number) => (v === undefined || v === null ? d : Number(v));
    const kind = input.kind === "outside" ? "outside" : input.kind === "studio" ? "studio" : null;
    if (!kind) return { ok: false, status: 400, error: "kind: studio or outside" };
    const level = Number(input.level) as Level;
    const promoterIds = parsePromoters(input.promoterIds);
    if (!promoterIds) return { ok: false, status: 400, error: "promoterIds: a list of people ids" };
    const people = await this.peopleMap();
    const fromPeople = this.derived({ hostPersonId: str(input.hostPersonId), promoterIds, authority: bool(input.authority), eventsBusiness: bool(input.eventsBusiness) } as HostEvent, people);
    const id = randomUUID();
    const code = deriveEventCode(this.pepper, id, 0);
    const e: HostEvent = {
      id, codeHash: eventCodeHash(this.pepper, code), source: "admin", name: (str(input.name) ?? "").trim(), kind,
      hostPersonId: str(input.hostPersonId), guestReaderId: str(input.guestReaderId), promoterIds, codeSeq: 0,
      sensitive: bool(input.sensitive), authority: fromPeople.authority, eventsBusiness: fromPeople.eventsBusiness,
      level, shareCodes: level === 3, studioLearning: bool(input.studioLearning),
      handleExchange: input.handleExchange === undefined ? !fromPeople.eventsBusiness : bool(input.handleExchange),
      welcomeText: (str(input.welcomeText) ?? "").trim(), lengthText: str(input.lengthText)?.trim() || null, conductUrl: str(input.conductUrl)?.trim() || null,
      capacity: num(input.capacity, 100), joinWindowMs: num(input.joinWindowMs, this.stranger.config().joinWindowMs),
      opensAt: num(input.opensAt, now), closesAt: num(input.closesAt, NaN), paused: false, pausedBy: null, closedAt: null, cardVersion: 1,
      frozenTerms: null, firstAckAt: null, publishedFunnel: null, publishedAt: null, createdAt: now,
    };
    const problem = this.validate(e, people);
    if (problem) return { ok: false, status: 400, error: problem };
    if (e.closesAt <= now) return { ok: false, status: 400, error: "closesAt is in the past" };
    if (e.shareCodes && !this.config().shareCodeSecret) {
      return { ok: false, status: 409, error: "share codes need RI_SHARE_CODE_SECRET (32+ bytes) set on the server" };
    }
    await this.store.createEvent(e);
    this.remember(e);
    logger.info("host_event_created", { eventId: e.id, kind: e.kind, level: e.level });
    // The plaintext code goes back once, here, and is never stored.
    return { ok: true, value: { event: e, code } };
  }

  /** The key invite tokens are hashed with (invites.ts). */
  pepperForInvites(): string {
    return this.pepper;
  }

  // ---- The event's link (persona tests, Kofi) ----

  /** The meetup link for a code: where the game lives, with ?meetup=. */
  linkFor(code: string): string {
    return `${this.stranger.config().publicBaseUrl}/?meetup=${code}`;
  }

  /**
   * An admin event's current code, derived again, or null: a closed or
   * finished meetup, an env code, or a random code from before migration 037.
   */
  codeFor(e: HostEvent): { code: string; link: string } | null {
    if (e.source !== "admin" || e.codeSeq === null) return null;
    const code = deriveEventCode(this.pepper, e.id, e.codeSeq);
    return { code, link: this.linkFor(code) };
  }

  /**
   * "get a new link": the old code stops at once, for everyone (the card,
   * the acknowledgement and sign-in all answer as for a code never made, so
   * anyone still on the card gets the neutral ending). Anyone already past the
   * card keeps going: their passes move to the new code, and the queue and the
   * games are kept by event id.
   */
  async newCode(id: string): Promise<AdminResult<{ code: string; link: string }>> {
    const e = this.byId.get(id) ?? (await this.store.getEvent(id));
    if (!e || e.source !== "admin") return { ok: false, status: 404, error: "No such event" };
    if (this.status(e) === "closed") return { ok: false, status: 409, error: "this meetup is closed." };
    const seq = (e.codeSeq ?? -1) + 1;
    const code = deriveEventCode(this.pepper, e.id, seq);
    const oldHash = e.codeHash;
    const updated = this.remember(await this.store.updateEvent(e.id, { codeHash: eventCodeHash(this.pepper, code), codeSeq: seq }));
    if (!updated) return { ok: false, status: 404, error: "No such event" };
    const wasOld = (c: string) => eventCodeHash(this.pepper, c) === oldHash;
    this.stranger.passes.moveMeetup(wasOld, code);
    this.stranger.matching?.moveMeetup(wasOld, code);
    logger.info("host_event_new_code", { eventId: e.id });
    return { ok: true, value: { code, link: this.linkFor(code) } };
  }

  /**
   * Before the first acknowledgement anything can change. After it (H17),
   * only pause, close, and lowering the level (which bumps the card version).
   */
  async patchEvent(id: string, patch: Record<string, unknown>, actor: "admin" | "host" = "admin"): Promise<AdminResult<HostEvent>> {
    const e = this.byId.get(id) ?? (await this.store.getEvent(id));
    if (!e) return { ok: false, status: 404, error: "No such event" };
    const keys = Object.keys(patch);
    if (actor === "host") {
      // A host only pauses, resumes, closes or lowers, never on a closed event,
      // and never lifts a pause the studio made.
      if (keys.some((k) => !["paused", "closed", "level"].includes(k))) return { ok: false, status: 403, error: "not allowed" };
      if (this.status(e) === "closed" || e.closedAt !== null) return { ok: false, status: 409, error: "this meetup is closed." };
      if (patch.paused === false && e.paused && e.pausedBy !== "host") {
        return { ok: false, status: 403, error: "the studio paused this meetup. it stays paused until the studio resumes it." };
      }
      if (patch.paused === true && e.paused && e.pausedBy !== "host") return { ok: true, value: e };
    }
    const frozen = e.firstAckAt !== null;
    const update: Partial<HostEvent> = {};
    for (const k of keys) {
      const v = patch[k];
      if (k === "paused") { update.paused = v === true; update.pausedBy = v === true ? actor : null; continue; }
      if (k === "closed") { if (v === true && e.closedAt === null) update.closedAt = this.now(); continue; }
      if (k === "promoterIds") {
        // Allowed at any time (it only keeps someone out of the queue), but see the checks below.
        const ids = parsePromoters(v);
        if (!ids) return { ok: false, status: 400, error: "promoterIds: a list of people ids" };
        update.promoterIds = ids;
        continue;
      }
      if (k === "level") {
        const lv = Number(v);
        if (frozen) {
          if (!(lv < e.level) || ![0, 1, 3].includes(lv)) return { ok: false, status: 409, error: "after the first acknowledgement the level can only go down" };
          if (e.kind === "studio" && lv === 1) return { ok: false, status: 400, error: "a studio event is level 0, or 3 with a guest reader" };
        }
        update.level = lv as Level;
        update.shareCodes = lv === 3;
        continue;
      }
      if (frozen) return { ok: false, status: 409, error: `${k} can't change after the first acknowledgement (H17)` };
      const editable: Record<string, keyof HostEvent> = {
        name: "name", welcomeText: "welcomeText", lengthText: "lengthText", conductUrl: "conductUrl", capacity: "capacity",
        joinWindowMs: "joinWindowMs", opensAt: "opensAt", closesAt: "closesAt", handleExchange: "handleExchange", studioLearning: "studioLearning",
        guestReaderId: "guestReaderId", hostPersonId: "hostPersonId", authority: "authority", eventsBusiness: "eventsBusiness", sensitive: "sensitive",
      };
      const field = editable[k];
      if (!field) return { ok: false, status: 400, error: `unknown field ${k}` };
      (update as Record<string, unknown>)[field] = v;
    }
    const next: HostEvent = { ...e, ...update };
    const people = await this.peopleMap();
    // The flags that come from the people (host type), never fewer than were ticked.
    const fromPeople = this.derived(next, people);
    if (fromPeople.authority !== next.authority) { next.authority = update.authority = fromPeople.authority; }
    if (fromPeople.eventsBusiness !== next.eventsBusiness) {
      // A business promoter turns the handle exchange off: before the first acknowledgement
      // that just happens; after it, the card's terms are frozen (H17), so it's refused.
      if (frozen && (e.frozenTerms?.handleExchange ?? e.handleExchange)) {
        return { ok: false, status: 409, error: "a dating or events business can't be added as a promoter after the first acknowledgement: the card promised the handle exchange" };
      }
      next.eventsBusiness = update.eventsBusiness = true;
      if (!frozen && patch.handleExchange === undefined) next.handleExchange = update.handleExchange = false;
    }
    const promotersChanged = update.promoterIds !== undefined && (update.promoterIds.length > 0) !== ((e.promoterIds ?? []).length > 0);
    if (frozen && ((update.level !== undefined && update.level < e.level) || promotersChanged)) next.cardVersion = e.cardVersion + 1;
    if (!frozen || update.level !== undefined || update.promoterIds !== undefined) {
      const problem = this.validate(next.kind === "studio" && next.level === 0 ? { ...next, guestReaderId: frozen ? null : next.guestReaderId } : next, people);
      if (problem) return { ok: false, status: 400, error: problem };
    }
    const saved = this.remember(await this.store.updateEvent(id, { ...update, ...(next.cardVersion !== e.cardVersion ? { cardVersion: next.cardVersion } : {}) }))!;
    logger.info("host_event_updated", { eventId: id, fields: keys });
    return { ok: true, value: saved };
  }

  /** What the admin sees of an event: never its code (only shown once at creation). */
  async adminView(e: HostEvent): Promise<Record<string, unknown>> {
    const { codeHash: _h, ...rest } = e;
    return { ...rest, status: await this.statusNow(e), joined: await this.store.countQueued(e.id) };
  }
}

export const HOST_TYPE_REQUIRED = `host type: one of ${HOST_TYPES.join(", ")} (club: no authority over attendees, not a business, not a sensitive community)`;

export function parseHostType(v: unknown): HostType | null {
  return typeof v === "string" && (HOST_TYPES as readonly string[]).includes(v) ? (v as HostType) : null;
}

/** A list of person ids, deduplicated; null when it isn't one. */
function parsePromoters(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x || x.length > 100)) return null;
  return [...new Set(v as string[])];
}

/** The names a promoting business goes by: its organisation, and its display name with any "(…)" part. */
export function businessNames(p: Pick<HostPerson, "displayName" | "organisation">): string[] {
  const out = new Set<string>();
  if (p.organisation && p.organisation.trim().length >= 3) out.add(p.organisation.trim());
  for (const m of p.displayName.matchAll(/\(([^)]+)\)/g)) if (m[1].trim().length >= 3) out.add(m[1].trim());
  return [...out];
}
