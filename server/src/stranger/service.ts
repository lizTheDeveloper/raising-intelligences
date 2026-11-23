import { logger } from "../logger.js";
import type { ChildSafetyStore } from "../safety/child-safety/store.js";
import { readStrangerConfig, strangerVisible, normalizeMeetupCode, pepperProblem, MIN_PEPPER_BYTES, type StrangerConfig } from "./config.js";
import { AgeVerification, type CheckOutcome, type PoolRefusal } from "./identity.js";
import { StrangerPasses, verifyOpenIdToken } from "./matrix-identity.js";
import { HOLDING_STATUSES, UNRESOLVED_STATUSES, type StrangerReport, type StrangerStore } from "./store.js";
import { randomUUID } from "node:crypto";

export interface HandleState { mine: "yes" | "no" | null; closed: boolean; matrixId?: string; error?: string }
export interface HandleOutcome { self: HandleState; other?: HandleState }
interface Exchange {
  holders: Partial<Record<StrangerSlot, string>>;
  answers: Partial<Record<StrangerSlot, "yes" | "no">>;
  closed: boolean;
  revealed: boolean;
  /** Set synchronously the moment a report arrives: no reveal after this. */
  reportFiled: boolean;
  /** The stored outcome has been read (once per process). */
  loaded: boolean;
  /** Seats already given (or scheduled) the neutral ending. */
  ended: Set<StrangerSlot>;
  window: ReturnType<typeof setTimeout> | null;
  answering: Promise<unknown>;
  reporting: Promise<unknown>;
}

/** The one ending a waiting seat ever sees when no handles are shared. */
const ENDED: HandleState = { mine: "yes", closed: true };
const EXCHANGE_TTL_MS = 6 * 60 * 60 * 1000;
/** A reporter's automatic suspensions are capped: past this many in the window, reports go to review only. */
const REPORT_SUSPENSION_CAP = 3;
const REPORT_CAP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const UNFOUNDED_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
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
  //
  // Nobody ever learns WHY an exchange didn't happen. Whatever the cause — the
  // other said no, never answered, a re-check refused the reveal, or a report
  // — a seat that said yes sees "waiting", then, after a random delay, the one
  // neutral ending. Only the seat that said no is told its own answer back.
  //
  // In memory: who sits in each seat (their Matrix id, learned only from a
  // verified join) and each seat's answer. Stored: the final outcome (so a
  // "no" or a reveal survives a restart) and the reports.
  private exchanges = new Map<string, Exchange>();
  /** Set by the socket layer: deliver a later state to one seat. */
  onHandleState: ((gameId: string, slot: StrangerSlot, state: HandleState) => void) | null = null;

  private exchange(gameId: string): Exchange {
    let x = this.exchanges.get(gameId);
    if (!x) {
      x = {
        holders: {}, answers: {}, closed: false, revealed: false, reportFiled: false, loaded: false,
        ended: new Set(), window: null, answering: Promise.resolve(), reporting: Promise.resolve(),
      };
      this.exchanges.set(gameId, x);
    }
    return x;
  }

  noteSeatHolder(gameId: string, slot: StrangerSlot, mxid: string): void {
    this.exchange(gameId).holders[slot] = mxid;
  }

  /**
   * One seat answers "yes" (with `ack`: the safety notice was read) or "no",
   * or asks for its current "status" (a reload). Answers are final. On the
   * second yes everything is re-checked — both still verified adults, neither
   * suspended, not blocked, no report on this game, the meetup still listed —
   * and only then is each told the OTHER's handle. One answer at a time per game.
   */
  answerHandle(gameId: string, slot: StrangerSlot, answer: unknown, ack: unknown): Promise<HandleOutcome> {
    const x = this.exchange(gameId);
    const run = x.answering.then(() => this.answerOne(gameId, x, slot, answer, ack));
    x.answering = run.catch(() => undefined);
    return run;
  }

  private selfView(x: Exchange, slot: StrangerSlot): HandleState {
    const mine = x.answers[slot];
    if (mine === "no") return { mine: "no", closed: true };
    if (mine === "yes") return x.ended.has(slot) ? ENDED : { mine: "yes", closed: false };
    return { mine: null, closed: false };
  }

  private async answerOne(gameId: string, x: Exchange, slot: StrangerSlot, answer: unknown, ack: unknown): Promise<HandleOutcome> {
    const seats = await this.matching?.runFor(gameId);
    if (!seats) return { self: { mine: null, closed: true, error: "Not available in this game." } };
    if (!x.loaded) {
      const outcome = await this.store.exchangeOutcome(gameId);
      x.loaded = true;
      if (outcome) x.closed = true;
      if (outcome === "revealed") x.revealed = true;
    }
    const other: StrangerSlot = slot === "parent1" ? "parent2" : "parent1";
    if (x.revealed) {
      // Already revealed (a reload, a dropped socket, a restart): resend, but
      // only while it would still be allowed now.
      let ok = false;
      try { ok = !x.reportFiled && (await this.revealAllowed(gameId, seats, x)); } catch { ok = false; }
      return { self: ok && x.holders[other] ? { mine: "yes", closed: true, matrixId: x.holders[other] } : ENDED };
    }
    if (answer === "status") return { self: this.selfView(x, slot) };
    if (x.answers[slot]) return { self: this.selfView(x, slot) };
    if (answer !== "yes" && answer !== "no") return { self: { ...this.selfView(x, slot), error: "Answer yes or no." } };
    if (answer === "yes" && ack !== true) return { self: { ...this.selfView(x, slot), error: "Read the safety notice first." } };
    x.answers[slot] = answer;
    if (answer === "no") {
      this.close(gameId, x);
      return { self: { mine: "no", closed: true } };
    }
    if (x.closed) {
      // Closed already (a no, a report, the window): looks like waiting.
      this.scheduleEnding(gameId, x, slot);
      return { self: { mine: "yes", closed: false } };
    }
    if (!x.window) {
      x.window = setTimeout(() => this.close(gameId, x), this.config().handleWindowMs);
      x.window.unref?.();
    }
    if (x.answers[other] !== "yes") return { self: { mine: "yes", closed: false } };
    // Both said yes: re-check everything at the moment of the reveal...
    let ok = false;
    try { ok = await this.revealAllowed(gameId, seats, x); } catch (err) {
      logger.error("stranger_reveal_check_failed", { gameId, error: err instanceof Error ? err.message : String(err) });
    }
    // ...and after the last await: a report marks the exchange synchronously
    // the instant it arrives, so one that landed during the checks shows here.
    if (!ok || x.closed || x.reportFiled) {
      logger.info("stranger_handle_exchange_refused", { gameId });
      this.close(gameId, x);
      return { self: { mine: "yes", closed: false } };
    }
    x.closed = true;
    x.revealed = true;
    if (x.window) clearTimeout(x.window);
    await this.store.closeExchange(gameId, "revealed");
    if (x.reportFiled) return { self: { mine: "yes", closed: false } }; // close() already scheduled the endings
    logger.info("stranger_handle_exchange", { gameId });
    return {
      self: { mine: "yes", closed: true, matrixId: x.holders[other] },
      other: { mine: "yes", closed: true, matrixId: x.holders[slot] },
    };
  }

  /** Ends the exchange without a reveal; every seat that said yes gets the neutral ending later. */
  private close(gameId: string, x: Exchange): void {
    if (x.window) clearTimeout(x.window);
    x.window = null;
    const wasOpen = !x.closed;
    x.closed = true;
    if (wasOpen && !x.revealed) {
      void this.store.closeExchange(gameId, "closed").catch((err) => logger.error("stranger_exchange_close_failed", { gameId, error: String(err) }));
      const evict = setTimeout(() => this.exchanges.delete(gameId), EXCHANGE_TTL_MS);
      evict.unref?.();
    }
    for (const s of ["parent1", "parent2"] as const) if (x.answers[s] === "yes") this.scheduleEnding(gameId, x, s);
  }

  private scheduleEnding(gameId: string, x: Exchange, slot: StrangerSlot): void {
    if (x.ended.has(slot)) return;
    x.ended.add(slot);
    const { handleEndingMinMs: lo, handleEndingMaxMs: hi } = this.config();
    const t = setTimeout(() => this.onHandleState?.(gameId, slot, ENDED), lo + Math.random() * Math.max(0, hi - lo));
    t.unref?.();
  }

  private async revealAllowed(gameId: string, seats: StrangerRunSeats, x: Exchange): Promise<boolean> {
    if (this.off() || x.reportFiled || !this.visible(seats.meetupCode)) return false;
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
   * the reported account pending review only when it is `open`:
   * - `counter`: the reporter's own seat was already reported in this game,
   *   or the reporter no longer checks out (so an abuser can't get their
   *   target suspended by reporting back);
   * - `review`: the reporter is over the cap of automatic suspensions, or has
   *   had a report found unfounded (lifted) recently (so one person can't
   *   suspend partner after partner).
   * Both go to an admin and suspend nobody by themselves. One per seat per game.
   */
  report(gameId: string, slot: StrangerSlot, reason: string, reporterMxid: string | null): Promise<{ ok: boolean; status?: string }> {
    const x = this.exchange(gameId);
    if (this.matching?.isRun(gameId)) {
      x.reportFiled = true;
      this.close(gameId, x);
    }
    const run = x.reporting.then(() => this.reportOne(gameId, x, slot, reason, reporterMxid));
    x.reporting = run.catch(() => undefined);
    return run;
  }

  private async reportOne(gameId: string, x: Exchange, slot: StrangerSlot, reason: string, reporterMxid: string | null): Promise<{ ok: boolean; status?: string }> {
    const seats = await this.matching?.runFor(gameId);
    if (!seats) return { ok: false };
    x.reportFiled = true;
    this.close(gameId, x);
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
    const now = Date.now();
    const theirs = await this.store.reportsBy(reporter);
    const suspending = theirs.filter((r) => r.createdAt >= now - REPORT_CAP_WINDOW_MS && (r.status === "open" || r.status === "kept" || r.status === "lifted")).length;
    const unfounded = theirs.some((r) => r.status === "lifted" && r.createdAt >= now - UNFOUNDED_WINDOW_MS);
    const status: StrangerReport["status"] = !reporterOk || wasReported ? "counter" : suspending >= REPORT_SUSPENSION_CAP || unfounded ? "review" : "open";
    const added = await this.store.addReport({ id: randomUUID(), gameId, reporter, reported, reason, createdAt: now, status });
    await this.store.addBlock(reporter, reported);
    if (added && status === "open") await this.store.suspend(reported, "report");
    logger.warn("stranger_report", { gameId, status });
    return { ok: true, status };
  }

  /**
   * An admin's decision on one report. Open: lift (the suspension goes only
   * if no other open or upheld report holds it, checked and lifted in one
   * step) or keep. Counter / review: keep (upheld: suspends now) or dismiss.
   * A decided report can't be decided again.
   */
  async resolveReport(id: string, action: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const report = await this.store.getReport(id);
    if (!report) return { status: 404, body: { error: "No such report" } };
    if (!UNRESOLVED_STATUSES.includes(report.status)) return { status: 409, body: { error: `Already ${report.status}` } };
    const allowed = report.status === "open" ? ["lift", "keep"] : ["keep", "dismiss"];
    if (typeof action !== "string" || !allowed.includes(action)) {
      return { status: 400, body: { error: `For a ${report.status} report: ${allowed.join(" or ")}` } };
    }
    const resolution = action === "lift" ? "lifted" : action === "keep" ? "kept" : "dismissed";
    if (!(await this.store.resolveReport(id, resolution))) return { status: 409, body: { error: "Already resolved" } };
    let suspensionLifted = false;
    if (action === "keep") await this.store.suspend(report.reported, "report upheld");
    if (action === "lift") suspensionLifted = await this.store.liftIfUnheld(report.reported);
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
