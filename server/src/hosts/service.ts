import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { normalizeMeetupCode, readStrangerConfig } from "../stranger/config.js";
import type { StrangerService, StrangerHostTools } from "../stranger/service.js";
import type { PartnerPayments } from "../payments/partner-payments.js";
import { buildCard, liveTerms, reconcileTerms, termsFor, type CardPayload, type LiveSettings } from "./card.js";
import { ackTokenHash, eventCodeHash, newAckToken, newEventCode } from "./codes.js";
import { MAX_EVENT_MS, readHostToolsConfig, type HostToolsConfig } from "./config.js";
import type { HostStore } from "./store.js";
import type { EventStatus, HostEvent, HostPerson, Level } from "./types.js";

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

  private async init(): Promise<void> {
    for (const e of await this.store.listEvents()) this.remember(e);
    if (this.active()) {
      await this.syncEnvEvents();
      await this.reconcileAll();
    }
    this.loaded = true;
  }

  /** RI_MEETUP_CODES: each listed code is a studio L0 event, its close rolled forward at each start. */
  private async syncEnvEvents(): Promise<void> {
    const now = this.now();
    const listed = new Set(this.envCodes.map((c) => eventCodeHash(this.pepper, c)));
    for (const hash of listed) {
      const existing = this.byHash.get(hash);
      if (existing && existing.source !== "env") continue; // an admin event already uses this code
      if (existing) {
        if (existing.closedAt !== null) continue; // closed by the admin: stays closed
        this.remember(await this.store.updateEvent(existing.id, { opensAt: now, closesAt: now + MAX_EVENT_MS }));
        continue;
      }
      const e: HostEvent = {
        id: randomUUID(), codeHash: hash, source: "env", name: ENV_EVENT_NAME, kind: "studio", hostPersonId: null, guestReaderId: null,
        sensitive: false, authority: false, eventsBusiness: false, level: 0, shareCodes: false, studioLearning: false, handleExchange: true,
        welcomeText: "", lengthText: null, conductUrl: null, capacity: 500, joinWindowMs: this.stranger.config().joinWindowMs,
        opensAt: now, closesAt: now + MAX_EVENT_MS, paused: false, closedAt: null, cardVersion: 1, frozenTerms: null, firstAckAt: null,
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

  /** Is this subject the event's host or guest reader (H12)? */
  async isHostOrGuest(e: HostEvent, subject: string): Promise<boolean> {
    for (const id of [e.hostPersonId, e.guestReaderId]) {
      if (!id) continue;
      const p = await this.store.getPerson(id);
      if (p && p.subject === subject) return true;
    }
    return false;
  }

  /** The queue's checks at an event (StrangerMatching.join). */
  async join(subject: string, meetupCode: string | null): Promise<{ ok: true } | { ok: false; status: number; error: string; card?: unknown }> {
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
    return { ok: true };
  }

  /** At JOIN_GAME: the host or guest reader never sits in a game at their own event (H12). */
  async refusedSeat(eventId: string | null | undefined, subject: string): Promise<boolean> {
    const e = this.eventById(eventId);
    return !!e && (await this.isHostOrGuest(e, subject));
  }

  /** Which end screens follow the report card in a game at this event (frozen terms). */
  endScreens(eventId: string): { handles: boolean; share: boolean; learning: boolean } | null {
    const e = this.eventById(eventId);
    if (!e) return null;
    const t = e.frozenTerms ?? liveTerms(e, this.live());
    return { handles: t.handleExchange, share: false, learning: false };
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

  async createPerson(input: { matrixId?: unknown; displayName?: unknown; roleText?: unknown; roleChecked?: unknown; agreementVersion?: unknown }): Promise<AdminResult<HostPerson>> {
    const mxid = typeof input.matrixId === "string" ? input.matrixId.trim() : "";
    if (!/^@[^:\s]+:[^\s]+$/.test(mxid)) return { ok: false, status: 400, error: "matrixId must look like @name:server" };
    const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
    if (!displayName || displayName.length > 60) return { ok: false, status: 400, error: "displayName: 1 to 60 characters" };
    const roleText = typeof input.roleText === "string" && input.roleText.trim() ? input.roleText.trim().slice(0, 80) : null;
    const roleChecked = typeof input.roleChecked === "string" && input.roleChecked.trim() ? input.roleChecked.trim().slice(0, 300) : null;
    if (!(await this.stranger.age.adultForPool(mxid)).ok) {
      return { ok: false, status: 409, error: "This account hasn't passed the 18+ check. They can do it from any meetup link with \"get ready early\"." };
    }
    const now = this.now();
    const p: HostPerson = {
      id: randomUUID(), subject: await this.stranger.age.subjectHash(mxid), displayName, roleText, roleChecked,
      roleCheckedAt: roleText && roleChecked ? now : null,
      agreementVersion: typeof input.agreementVersion === "string" && input.agreementVersion.trim() ? input.agreementVersion.trim().slice(0, 40) : this.config().agreementVersion,
      agreementAt: now, status: "approved", createdAt: now,
    };
    if (!(await this.store.createPerson(p))) return { ok: false, status: 409, error: "This account is already a host or guest reader." };
    logger.info("host_person_created", { id: p.id });
    return { ok: true, value: p };
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
    if (e.sensitive) return "a sensitive community can't host (Q4); its member can be a guest reader at a studio event";
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
    for (const id of [e.hostPersonId, e.guestReaderId]) {
      if (!id) continue;
      const p = people.get(id);
      if (!p) return "no such host or guest reader";
      if (p.status !== "approved") return "that host or guest reader isn't approved";
    }
    return null;
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
    const code = newEventCode();
    const e: HostEvent = {
      id: randomUUID(), codeHash: eventCodeHash(this.pepper, code), source: "admin", name: (str(input.name) ?? "").trim(), kind,
      hostPersonId: str(input.hostPersonId), guestReaderId: str(input.guestReaderId),
      sensitive: bool(input.sensitive), authority: bool(input.authority), eventsBusiness: bool(input.eventsBusiness),
      level, shareCodes: level === 3, studioLearning: bool(input.studioLearning),
      handleExchange: input.handleExchange === undefined ? !bool(input.eventsBusiness) : bool(input.handleExchange),
      welcomeText: (str(input.welcomeText) ?? "").trim(), lengthText: str(input.lengthText)?.trim() || null, conductUrl: str(input.conductUrl)?.trim() || null,
      capacity: num(input.capacity, 100), joinWindowMs: num(input.joinWindowMs, this.stranger.config().joinWindowMs),
      opensAt: num(input.opensAt, now), closesAt: num(input.closesAt, NaN), paused: false, closedAt: null, cardVersion: 1,
      frozenTerms: null, firstAckAt: null, publishedFunnel: null, publishedAt: null, createdAt: now,
    };
    const problem = this.validate(e, await this.peopleMap());
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

  /**
   * Before the first acknowledgement anything can change. After it (H17),
   * only pause, close, and lowering the level (which bumps the card version).
   */
  async patchEvent(id: string, patch: Record<string, unknown>): Promise<AdminResult<HostEvent>> {
    const e = this.byId.get(id) ?? (await this.store.getEvent(id));
    if (!e) return { ok: false, status: 404, error: "No such event" };
    const keys = Object.keys(patch);
    const frozen = e.firstAckAt !== null;
    const update: Partial<HostEvent> = {};
    for (const k of keys) {
      const v = patch[k];
      if (k === "paused") { update.paused = v === true; continue; }
      if (k === "closed") { if (v === true && e.closedAt === null) update.closedAt = this.now(); continue; }
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
    if (frozen && update.level !== undefined && update.level < e.level) next.cardVersion = e.cardVersion + 1;
    if (!frozen || update.level !== undefined) {
      const problem = this.validate(next.kind === "studio" && next.level === 0 ? { ...next, guestReaderId: frozen ? null : next.guestReaderId } : next, await this.peopleMap());
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
