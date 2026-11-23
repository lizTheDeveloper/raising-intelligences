import { logger } from "../logger.js";
import type { ChildSafetyStore } from "../safety/child-safety/store.js";
import { readStrangerConfig, strangerVisible, normalizeMeetupCode, pepperProblem, MIN_PEPPER_BYTES, type StrangerConfig } from "./config.js";
import { AgeVerification, type CheckOutcome, type PoolRefusal } from "./identity.js";
import { StrangerPasses, verifyOpenIdToken } from "./matrix-identity.js";
import { HOLDING_STATUSES, type StrangerStore } from "./store.js";
import { randomUUID } from "node:crypto";

export interface HandleState { mine: "yes" | "no" | null; closed: boolean; matrixId?: string; error?: string }
export interface HandleOutcome { self: HandleState; other?: HandleState }
interface Exchange {
  holders: Partial<Record<StrangerSlot, string>>;
  answers: Partial<Record<StrangerSlot, "yes" | "no">>;
  closed: boolean;
  /** Set synchronously the moment a report arrives: no reveal after this. */
  reportFiled: boolean;
  answering: Promise<unknown>;
  reporting: Promise<unknown>;
}
import { StrangerMatching, type MatchingHooks, type StrangerRunSeats, type StrangerSlot } from "./matching.js";

/**
 * Everything stranger mode needs, in one place, so the routes and the socket
 * layer share one switch, one set of passes and one age gate.
 */
export interface StrangerServiceDeps {
  config: () => StrangerConfig;
  passes: StrangerPasses;
  age: AgeVerification;
  /** OpenID token → Matrix id, or null. Synapse userinfo by default. */
  verifyMatrix: (openIdToken: unknown) => Promise<string | null>;
  store: StrangerStore;
}

export class StrangerService {
  readonly config: () => StrangerConfig;
  readonly passes: StrangerPasses;
  readonly age: AgeVerification;
  readonly verifyMatrix: (openIdToken: unknown) => Promise<string | null>;
  readonly store: StrangerStore;
  /** Set by the socket layer, which owns games and seats (registerSocketHandlers). */
  matching: StrangerMatching | null = null;

  constructor(deps: StrangerServiceDeps) {
    this.config = deps.config;
    this.passes = deps.passes;
    this.age = deps.age;
    this.verifyMatrix = deps.verifyMatrix;
    this.store = deps.store;
  }

  attachMatching(hooks: MatchingHooks): StrangerMatching {
    this.matching = new StrangerMatching({ age: this.age, store: this.store, config: this.config, hooks });
    return this.matching;
  }

  /**
   * May the holder of this pass sit in this seat of this stranger game? Only
   * the account the seat was matched to, still an eligible adult, still on
   * a visible meetup.
   */
  /** The seat holder's Matrix id when they may sit in this seat, else null. */
  async seatHolderOk(seats: StrangerRunSeats, slot: StrangerSlot, pass: unknown): Promise<string | null> {
    if (this.off()) return null;
    const p = await this.resolveLive(pass);
    if (!p || p === "hidden") return null;
    if ((await this.age.subjectHash(p.subject)) !== seats[slot]) return null;
    if (!(await this.age.adultForPool(p.subject)).ok) return null;
    if (await this.store.isSuspended(seats[slot])) return null;
    return p.subject;
  }

  // ---- The handle exchange (after the report card) and reports ----
  // In memory: who is sitting in each seat (their Matrix id, learned only from
  // a verified join) and each seat's answer. A restart forgets answers; both
  // players simply answer again. Reports are stored.
  private exchanges = new Map<string, Exchange>();

  private exchange(gameId: string): Exchange {
    let x = this.exchanges.get(gameId);
    if (!x) {
      x = { holders: {}, answers: {}, closed: false, reportFiled: false, answering: Promise.resolve(), reporting: Promise.resolve() };
      this.exchanges.set(gameId, x);
    }
    return x;
  }

  noteSeatHolder(gameId: string, slot: StrangerSlot, mxid: string): void {
    this.exchange(gameId).holders[slot] = mxid;
  }

  /**
   * One seat answers. Answers are final; any "no" closes it for both. A yes
   * requires `ack` (the safety notice was shown and read). On the second yes
   * everything is re-checked — both still verified adults, neither suspended,
   * not blocked, no report on this game — and only then is each told the
   * OTHER's handle. Answers for one game are taken one at a time.
   */
  answerHandle(gameId: string, slot: StrangerSlot, answer: unknown, ack: unknown): Promise<HandleOutcome> {
    const x = this.exchange(gameId);
    const run = x.answering.then(() => this.answerOne(gameId, x, slot, answer, ack));
    x.answering = run.catch(() => undefined);
    return run;
  }

  private async answerOne(gameId: string, x: Exchange, slot: StrangerSlot, answer: unknown, ack: unknown): Promise<HandleOutcome> {
    const seats = await this.matching?.runFor(gameId);
    if (!seats) return { self: { mine: null, closed: true, error: "Not available in this game." } };
    const other: StrangerSlot = slot === "parent1" ? "parent2" : "parent1";
    const shut = () => x.closed || x.reportFiled;
    if (shut() || x.answers[slot]) return { self: { mine: x.answers[slot] ?? null, closed: shut() } };
    if (answer !== "yes" && answer !== "no") return { self: { mine: null, closed: false, error: "Answer yes or no." } };
    if (answer === "yes" && ack !== true) return { self: { mine: null, closed: false, error: "Read the safety notice first." } };
    x.answers[slot] = answer;
    if (answer === "no") {
      x.closed = true;
      return { self: { mine: "no", closed: true }, other: { mine: x.answers[other] ?? null, closed: true } };
    }
    if (x.answers[other] !== "yes") return { self: { mine: "yes", closed: false } };
    // Both said yes: re-check everything at the moment of the reveal...
    const ok = await this.revealAllowed(gameId, seats, x);
    // ...and once more after the last await: a report marks the exchange
    // synchronously the instant it arrives, so one that landed during the
    // checks above is seen here, with nothing awaited between this and the send.
    if (!ok || shut()) {
      x.closed = true;
      logger.info("stranger_handle_exchange_refused", { gameId });
      return { self: { mine: "yes", closed: true }, other: { mine: "yes", closed: true } };
    }
    x.closed = true;
    logger.info("stranger_handle_exchange", { gameId });
    return {
      self: { mine: "yes", closed: true, matrixId: x.holders[other] },
      other: { mine: "yes", closed: true, matrixId: x.holders[slot] },
    };
  }

  private async revealAllowed(gameId: string, seats: StrangerRunSeats, x: Exchange): Promise<boolean> {
    if (this.off() || x.reportFiled) return false;
    if (await this.store.gameReported(gameId)) return false;
    if (await this.store.isBlocked(seats.parent1, seats.parent2)) return false;
    for (const s of ["parent1", "parent2"] as const) {
      const mxid = x.holders[s];
      if (!mxid) return false;
      if ((await this.age.subjectHash(mxid)) !== seats[s]) return false;
      if (!(await this.age.adultForPool(mxid)).ok) return false;
      if (await this.store.isSuspended(seats[s])) return false;
    }
    return true;
  }

  /**
   * A report, from either seat, at any time. It closes the exchange at once
   * (before anything is awaited) and blocks the pair for good. It suspends
   * the reported account pending review — unless the reporter's own seat was
   * already reported in this game, or the reporter no longer checks out: then
   * it is a counter-report, kept for review, suspending nobody (so an abuser
   * can't get their target suspended by reporting back). One per seat per game.
   */
  report(gameId: string, slot: StrangerSlot, reason: string, reporterMxid: string | null): Promise<{ ok: boolean; counter?: boolean }> {
    const x = this.exchange(gameId);
    x.reportFiled = true;
    x.closed = true;
    const run = x.reporting.then(() => this.reportOne(gameId, slot, reason, reporterMxid));
    x.reporting = run.catch(() => undefined);
    return run;
  }

  private async reportOne(gameId: string, slot: StrangerSlot, reason: string, reporterMxid: string | null): Promise<{ ok: boolean; counter?: boolean }> {
    const seats = await this.matching?.runFor(gameId);
    if (!seats) return { ok: false };
    const other: StrangerSlot = slot === "parent1" ? "parent2" : "parent1";
    const reporter = seats[slot];
    const reported = seats[other];
    const prior = await this.store.reportsForGame(gameId);
    if (prior.some((r) => r.reporter === reporter)) return { ok: true };
    const reporterOk =
      !!reporterMxid &&
      (await this.age.subjectHash(reporterMxid)) === reporter &&
      (await this.age.adultForPool(reporterMxid)).ok &&
      !(await this.store.isSuspended(reporter));
    const wasReported = prior.some((r) => r.reported === reporter && HOLDING_STATUSES.has(r.status));
    const counter = !reporterOk || wasReported;
    const added = await this.store.addReport({
      id: randomUUID(), gameId, reporter, reported, reason, createdAt: Date.now(), status: counter ? "counter" : "open",
    });
    await this.store.addBlock(reporter, reported);
    if (added && !counter) await this.store.suspend(reported, "report");
    logger.warn("stranger_report", { gameId, counter });
    return { ok: true, counter };
  }

  /**
   * An admin's decision on one report. An open report: lift (the suspension
   * goes only if no other open or upheld report still holds it) or keep. A
   * counter-report: keep (upheld: suspends now) or dismiss. A report already
   * decided can't be decided again.
   */
  async resolveReport(id: string, action: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const report = await this.store.getReport(id);
    if (!report) return { status: 404, body: { error: "No such report" } };
    if (report.status !== "open" && report.status !== "counter") return { status: 409, body: { error: `Already ${report.status}` } };
    const allowed = report.status === "open" ? ["lift", "keep"] : ["keep", "dismiss"];
    if (typeof action !== "string" || !allowed.includes(action)) {
      return { status: 400, body: { error: `For a ${report.status} report: ${allowed.join(" or ")}` } };
    }
    const resolution = action === "lift" ? "lifted" : action === "keep" ? "kept" : "dismissed";
    if (!(await this.store.resolveReport(id, resolution))) return { status: 409, body: { error: "Already resolved" } };
    let suspensionLifted = false;
    if (action === "keep") {
      await this.store.suspend(report.reported, "report upheld");
    } else if (action === "lift") {
      const holding = (await this.store.reportsAgainst(report.reported)).filter((r) => r.id !== id && HOLDING_STATUSES.has(r.status));
      if (holding.length === 0) {
        await this.store.lift(report.reported);
        suspensionLifted = true;
      }
    }
    logger.info("stranger_report_resolved", { id, action, suspensionLifted });
    return { status: 200, body: { ok: true, suspensionLifted } };
  }

  static fromEnv(store: StrangerStore, childSafety: ChildSafetyStore, env: NodeJS.ProcessEnv = process.env): StrangerService {
    let cfg = readStrangerConfig(env);
    const pepper = env.RI_STRANGER_PEPPER ?? "";
    const problem = pepperProblem(pepper);
    if (cfg.mode !== "off" && problem) {
      // Fail closed: no stranger mode on a missing or guessable pepper.
      logger.error("stranger_mode_refused", {
        reason: `RI_STRANGER_PEPPER ${problem} (needs ${MIN_PEPPER_BYTES}+ bytes, e.g. openssl rand -hex 32)`,
        requestedMode: cfg.mode,
      });
      cfg = { ...cfg, mode: "off" };
    }
    return new StrangerService({
      config: () => cfg,
      passes: new StrangerPasses(),
      age: new AgeVerification({ store, config: () => cfg, childSafety, pepper }),
      verifyMatrix: (t) => verifyOpenIdToken(t, cfg.matrixUserinfoUrl),
      store,
    });
  }

  /** The switch is off: every stranger surface answers as if it didn't exist. */
  off(): boolean {
    return this.config().mode === "off";
  }

  visible(code: unknown): boolean {
    return strangerVisible(this.config(), code);
  }

  /**
   * A pass that is valid, on a meetup that is still visible, and whose account
   * hasn't since been found to be a minor or banned. A minor result retires
   * every pass of that account on the spot.
   */
  async resolveLive(pass: unknown): Promise<{ subject: string; meetupCode: string | null } | "hidden" | null> {
    const p = this.passes.resolve(pass);
    if (!p) return null;
    if (!this.visible(p.meetupCode)) return "hidden";
    const pool = await this.age.adultForPool(p.subject);
    if (pool.reason === "minor" || pool.reason === "banned") {
      this.passes.revokeSubject(p.subject);
      return null;
    }
    return p;
  }

  async issuePass(openIdToken: unknown, meetup: unknown, ip?: string): Promise<{ pass: string } | { status: number; error: string }> {
    if (!this.visible(meetup)) return { status: 404, error: "Not found" };
    if (ip && (await this.age.ipBanned(ip))) return { status: 403, error: "stranger mode isn't available here." };
    const subject = await this.verifyMatrix(openIdToken);
    if (!subject) return { status: 401, error: "Sign in with your multiversegames.ai account first." };
    const pool = await this.age.adultForPool(subject);
    if (pool.reason === "banned") return { status: 403, error: "This account can't use stranger mode." };
    if (pool.reason === "minor") return { status: 403, error: "Stranger mode is for adults only." };
    return { pass: this.passes.issue(subject, normalizeMeetupCode(meetup)) };
  }

  async me(subject: string): Promise<{ consented: boolean; age: CheckOutcome; eligible: boolean; reason?: PoolRefusal }> {
    const consented = await this.age.hasConsent(subject);
    const row = await this.age.storedOutcome(subject);
    const pool = await this.age.adultForPool(subject);
    return { consented, age: row ?? "unverified", eligible: pool.ok, ...(pool.ok ? {} : { reason: pool.reason }) };
  }

  logState(): void {
    const cfg = this.config();
    logger.info("stranger_mode", {
      mode: cfg.mode,
      meetupCodes: cfg.meetupCodes.size,
      identityConfigured: this.age.configured(),
      identityWebhook: !!cfg.identityWebhookSecret,
    });
    if (cfg.mode !== "off" && !this.age.configured()) {
      // Visible but nobody can pass the age check: the pool stays empty. Fail closed, loudly.
      logger.error("stranger_mode_identity_unconfigured", { mode: cfg.mode });
    }
  }
}
