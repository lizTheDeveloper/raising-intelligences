import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../../src/app.js";
import { InMemoryGameRepository } from "../../src/db/repository.js";
import { InMemoryAdminQueries } from "../../src/db/admin-queries.js";
import { MockLLMClient } from "../../src/llm/mock.js";
import { AgeVerification } from "../../src/stranger/identity.js";
import { StrangerPasses } from "../../src/stranger/matrix-identity.js";
import { StrangerService } from "../../src/stranger/service.js";
import type { StrangerConfig } from "../../src/stranger/config.js";
import { PartnerPayments } from "../../src/payments/partner-payments.js";
import type { PaymentConfig } from "../../src/payments/config.js";
import { HostTools } from "../../src/hosts/service.js";
import type { HostToolsConfig } from "../../src/hosts/config.js";
import { TestClient, connect } from "./socket-client.js";
import { SOCKET_EVENTS as E } from "../../src/socket/protocol.js";
import { FakeIdentity, strangerConfig } from "./fake-identity.js";
import { FakeCheckout, paywallConfig } from "./fake-stripe.js";
import type { GameEvent } from "../../src/types.js";
import type { LLMClient } from "../../src/llm/client.js";

export const ADMIN = { Authorization: "Bearer admin-test-token" };
export const SHARE_SECRET = "s".repeat(48);

export function hostConfig(overrides: Partial<HostToolsConfig> = {}): HostToolsConfig {
  return {
    enabled: true,
    shareCodeSecret: SHARE_SECRET,
    traceRetentionDays: null,
    traceWhere: "studio",
    production: true,
    agreementVersion: "short-form-1",
    ...overrides,
  };
}

/**
 * The whole app, as production builds it, with stranger mode in meetup mode,
 * a fake Stripe Identity, a switchable paywall and host tools on. Players sign
 * in through the real /stranger/pass route: an OpenID token "tok:<mxid>"
 * stands for that Matrix account.
 */
export class HostHarness {
  built!: BuiltServer;
  origin = "";
  repo = new InMemoryGameRepository();
  stranger!: StrangerService;
  hosts!: HostTools;
  mock = new MockLLMClient();
  strangerCfg: StrangerConfig;
  hostCfg: HostToolsConfig;
  paywall: PaymentConfig;
  clock: { now: number } | null = null;
  clients: TestClient[] = [];
  private savedAdmin = process.env.ADMIN_TOKEN;
  /** How the app's model client is built around `mock`: by default the bare mock; pass the production wrapper to see traces. */
  private wrapLlm: (mock: MockLLMClient) => LLMClient;

  constructor(opts: { stranger?: Partial<StrangerConfig>; host?: Partial<HostToolsConfig>; paywallOn?: boolean; clock?: number; wrapLlm?: (mock: MockLLMClient) => LLMClient } = {}) {
    this.wrapLlm = opts.wrapLlm ?? ((m) => m);
    this.strangerCfg = strangerConfig({ joinWindowMs: 60_000, meetupCodes: new Set(), ...opts.stranger });
    this.hostCfg = hostConfig(opts.host);
    this.paywall = paywallConfig({ switchOn: opts.paywallOn ?? false });
    if (opts.clock !== undefined) this.clock = { now: opts.clock };
  }

  now = () => (this.clock ? this.clock.now : Date.now());

  async boot(): Promise<this> {
    process.env.DISABLE_PORTRAITS = "1";
    process.env.ADMIN_TOKEN = "admin-test-token";
    const cfg = () => this.strangerCfg;
    this.stranger = new StrangerService({
      config: cfg,
      passes: new StrangerPasses(),
      age: new AgeVerification({ store: this.repo.stranger, api: new FakeIdentity(), config: cfg, childSafety: this.repo.childSafety, pepper: "k".repeat(64) }),
      verifyMatrix: async (t) => (typeof t === "string" && t.startsWith("tok:") ? t.slice(4) : null),
      store: this.repo.stranger,
    });
    const payments = new PartnerPayments({ store: this.repo.partnerPayments, config: () => this.paywall, checkout: new FakeCheckout() });
    this.hosts = new HostTools({
      store: this.repo.hosts,
      stranger: this.stranger,
      payments,
      config: () => this.hostCfg,
      pepper: "k".repeat(64),
      envCodes: this.strangerCfg.meetupCodes,
      now: this.now,
    });
    this.built = buildServer({
      llm: this.wrapLlm(this.mock),
      repo: this.repo,
      adminQueries: new InMemoryAdminQueries(),
      enableEviction: false,
      allowedOrigin: "*",
      socketPath: "/socket.io",
      stranger: this.stranger,
      payments,
      hostTools: this.hosts,
      // The same stand-in sign-in for the account's own routes (/user/:id/kids).
      verifyMatrix: async (t) => (typeof t === "string" && t.startsWith("tok:") ? t.slice(4) : null),
    });
    await this.hosts.ready;
    await new Promise<void>((r) => this.built.httpServer.listen(0, "127.0.0.1", () => r()));
    this.origin = `http://127.0.0.1:${(this.built.httpServer.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    for (const c of this.clients.splice(0)) c.close();
    await this.built.close();
    if (this.savedAdmin === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = this.savedAdmin;
  }

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${this.origin}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json as Record<string, any>, text, headers: res.headers };
  }
  post(path: string, body: unknown, headers: Record<string, string> = {}) { return this.req("POST", path, body, headers); }
  get(path: string, headers: Record<string, string> = {}) { return this.req("GET", path, undefined, headers); }

  /** A verified adult (or minor), as the stored outcome of a passed ID check. */
  async verify(mxid: string, outcome: "adult" | "minor" = "adult"): Promise<string> {
    const subject = await this.stranger.age.subjectHash(mxid);
    await this.repo.stranger.setVerification({ subject, outcome, livemode: true, verifiedAt: Date.now(), sessionId: `vs_${mxid}` });
    return subject;
  }

  async person(mxid: string, displayName: string, extra: Record<string, unknown> = {}): Promise<string> {
    await this.verify(mxid);
    // Host type defaults to "club" (no authority, not a business, not sensitive): the old per-event answers.
    const r = await this.post("/admin/host-tools/hosts", { matrixId: mxid, displayName, hostType: "club", ...extra }, ADMIN);
    if (r.status !== 200) throw new Error(`person: ${r.status} ${r.text}`);
    return r.body.id as string;
  }

  async event(input: Record<string, unknown>): Promise<{ id: string; code: string; body: Record<string, any> }> {
    const t = this.now();
    const r = await this.post("/admin/host-tools/events", { name: "tuesday tea", kind: "studio", level: 0, opensAt: t - 1000, closesAt: t + 3 * 24 * 3600 * 1000, ...input }, ADMIN);
    if (r.status !== 200) throw new Error(`event: ${r.status} ${r.text}`);
    return { id: r.body.event.id as string, code: r.body.code as string, body: r.body };
  }

  async card(code: string) { return this.get(`/events/card?meetup=${encodeURIComponent(code)}`); }

  /** Each player browses from their own address, as at a real meetup (the routes are rate-limited per IP). */
  private ips = new Map<string, string>();
  ipFor(key: string): Record<string, string> {
    if (!this.ips.has(key)) this.ips.set(key, `10.9.${Math.floor(this.ips.size / 250)}.${(this.ips.size % 250) + 1}`);
    return { "X-Forwarded-For": this.ips.get(key)! };
  }

  /** Card → continue → sign in. Returns the stranger pass. */
  async arrive(mxid: string, code: string, opts: { verify?: boolean } = {}): Promise<string> {
    if (opts.verify !== false) await this.verify(mxid);
    const ip = this.ipFor(mxid);
    const c = await this.get(`/events/card?meetup=${encodeURIComponent(code)}`, ip);
    if (c.status !== 200) throw new Error(`card: ${c.status}`);
    const ack = await this.post("/events/ack", { meetup: code, cardVersion: c.body.card.version }, ip);
    if (ack.status !== 200) throw new Error(`ack: ${ack.status} ${ack.text}`);
    const p = await this.post("/stranger/pass", { openIdToken: `tok:${mxid}`, meetup: code, ackToken: ack.body.ackToken }, ip);
    if (p.status !== 200) throw new Error(`pass: ${p.status} ${p.text}`);
    this.ips.set(p.body.pass as string, ip["X-Forwarded-For"]);
    return p.body.pass as string;
  }

  queue(pass: string, childName = "Wren", displayName = "Sam") {
    return this.post("/stranger/queue/join", { pass, childName, displayName }, this.ipFor(pass));
  }

  async client(): Promise<TestClient> {
    const c = await connect(this.origin);
    this.clients.push(c);
    return c;
  }

  async sit(pass: string, m: Record<string, unknown>): Promise<TestClient> {
    const c = await this.client();
    const joined = c.once(E.JOINED);
    c.emit(E.JOIN_GAME, { gameId: m.gameId, playerToken: m.playerToken, strangerPass: pass });
    await joined;
    return c;
  }

  /** Two adults arrive at a meetup, are matched, and both sit down. */
  async pair(code: string, a = "@alice:multiversegames.ai", b = "@bob:multiversegames.ai") {
    const pa = await this.arrive(a, code);
    const pb = await this.arrive(b, code);
    await this.queue(pa, "Wren", "Ash");
    await this.queue(pb, "Juniper", "Bea");
    const ma = (await this.post("/stranger/queue/poll", { pass: pa }, this.ipFor(pa))).body;
    const mb = (await this.post("/stranger/queue/poll", { pass: pb }, this.ipFor(pb))).body;
    if (ma.status !== "matched" || mb.status !== "matched") throw new Error(`not matched: ${JSON.stringify([ma, mb])}`);
    const A = await this.sit(pa, ma);
    const B = await this.sit(pb, mb);
    return { A, B, pa, pb, ma, mb, gameId: ma.gameId as string };
  }

  events(n: number): GameEvent[] {
    return Array.from({ length: n }, (_, i) => ({ eventNumber: i + 1, age: 3, description: `Scenario ${i + 1}.`, setting: "Home", trigger: "Test" }));
  }
}
