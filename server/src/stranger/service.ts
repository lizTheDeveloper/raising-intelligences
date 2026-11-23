import { logger } from "../logger.js";
import type { ChildSafetyStore } from "../safety/child-safety/store.js";
import { readStrangerConfig, strangerVisible, normalizeMeetupCode, pepperProblem, MIN_PEPPER_BYTES, type StrangerConfig } from "./config.js";
import { AgeVerification, type CheckOutcome, type PoolRefusal } from "./identity.js";
import { StrangerPasses, verifyOpenIdToken } from "./matrix-identity.js";
import type { StrangerStore } from "./store.js";
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
  async seatHolderOk(seats: StrangerRunSeats, slot: StrangerSlot, pass: unknown): Promise<boolean> {
    if (this.off()) return false;
    const p = await this.resolveLive(pass);
    if (!p || p === "hidden") return false;
    if ((await this.age.subjectHash(p.subject)) !== seats[slot]) return false;
    if (!(await this.age.adultForPool(p.subject)).ok) return false;
    return !(await this.store.isSuspended(seats[slot]));
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
