import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { AgeVerification, CONSENT_VERSION } from "../src/stranger/identity.js";
import { InMemoryStrangerStore } from "../src/stranger/store.js";
import { StrangerPasses } from "../src/stranger/matrix-identity.js";
import { StrangerService } from "../src/stranger/service.js";
import type { StrangerConfig } from "../src/stranger/config.js";
import { signWebhookPayload } from "../src/payments/stripe.js";
import { FakeIdentity, strangerConfig, dobYearsAgo } from "./helpers/fake-identity.js";

const ALICE = "@alice:multiversegames.ai";

describe("stranger mode routes", () => {
  let built: BuiltServer;
  let base: string;
  let cfg: StrangerConfig;
  let identity: FakeIdentity;
  let tokens: Map<string, string>;

  beforeEach(async () => {
    cfg = strangerConfig();
    identity = new FakeIdentity();
    tokens = new Map([["tok-alice", ALICE], ["tok-bob", "@bob:multiversegames.ai"]]);
    const repo = new InMemoryGameRepository();
    const store = new InMemoryStrangerStore();
    const stranger = new StrangerService({
      config: () => cfg,
      passes: new StrangerPasses(),
      age: new AgeVerification({ store, api: identity, config: () => cfg, childSafety: repo.childSafety, pepper: "p".repeat(64) }),
      verifyMatrix: async (t) => tokens.get(String(t)) ?? null,
      store,
    });
    built = buildServer({
      llm: new MockLLMClient(),
      repo,
      adminQueries: new InMemoryAdminQueries(),
      enableEviction: false,
      allowedOrigin: "*",
      socketPath: "/socket.io",
      stranger,
    });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    await built.close();
  });

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function passFor(token = "tok-alice"): Promise<string> {
    const r = await post("/stranger/pass", { openIdToken: token, meetup: "tea-party" });
    expect(r.status).toBe(200);
    return r.body.pass as string;
  }

  /** What a path that doesn't exist answers: "off" must look exactly like this. */
  async function unknownGet() {
    const r = await fetch(`${base}/no-such-route-${Date.now()}`);
    return { status: r.status, body: await r.text() };
  }
  async function unknownPost() {
    const r = await post(`/no-such-route-${Date.now()}`, {});
    return r.status;
  }

  it("off: every stranger route, the webhook included, answers exactly like an unknown path", async () => {
    cfg = strangerConfig({ mode: "off" });
    const u = await unknownGet();
    const s1 = await fetch(`${base}/stranger/status?meetup=tea-party`);
    expect({ status: s1.status, body: await s1.text() }).toEqual(u);
    const unknown = await unknownPost();
    expect((await post("/stranger/pass", { openIdToken: "tok-alice", meetup: "tea-party" })).status).toBe(unknown);
    expect((await post("/stripe/identity-webhook", "{}", { "Stripe-Signature": "t=1,v1=x" })).status).toBe(unknown);
  });

  it("meetup: visible only with a listed code", async () => {
    const u = await unknownGet();
    expect((await fetch(`${base}/stranger/status?meetup=nope`)).status).toBe(u.status);
    expect((await fetch(`${base}/stranger/status`)).status).toBe(u.status);
    const ok = await fetch(`${base}/stranger/status?meetup=Tea-Party`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ visible: true, consentVersion: CONSENT_VERSION });
  });

  it("a pass needs a real Matrix sign-in", async () => {
    expect((await post("/stranger/pass", { openIdToken: "forged", meetup: "tea-party" })).status).toBe(401);
    expect((await post("/stranger/pass", { meetup: "tea-party" })).status).toBe(401);
    expect(typeof (await passFor())).toBe("string");
  });

  it("switching the mode off mid-evening shuts out passes already issued", async () => {
    const pass = await passFor();
    cfg = strangerConfig({ mode: "off" });
    expect((await post("/stranger/me", { pass })).status).toBe(await unknownPost());
  });

  it("consent, then the ID check, then the pool — in that order only", async () => {
    const pass = await passFor();
    expect((await post("/stranger/me", { pass })).body).toMatchObject({ consented: false, age: "unverified", eligible: false });
    expect((await post("/stranger/identity/start", { pass })).status).toBe(409);
    expect((await post("/stranger/consent", { pass, version: "old" })).status).toBe(400);
    expect((await post("/stranger/consent", { pass, version: CONSENT_VERSION })).status).toBe(200);
    const started = await post("/stranger/identity/start", { pass });
    expect(started.status).toBe(200);
    expect(String(started.body.url)).toContain("verify.stripe.test");
    identity.complete(identity.last(), dobYearsAgo(29));
    const checked = await post("/stranger/identity/check", { pass });
    expect(checked.body).toMatchObject({ age: "adult", eligible: true });
  });

  it("one pass per account: signing in again retires the old pass", async () => {
    const first = await passFor();
    const second = await passFor();
    expect((await post("/stranger/me", { pass: first })).status).toBe(401);
    expect((await post("/stranger/me", { pass: second })).status).toBe(200);
  });

  it("a minor is told plainly and kept out", async () => {
    const pass = await passFor("tok-bob");
    await post("/stranger/consent", { pass, version: CONSENT_VERSION });
    await post("/stranger/identity/start", { pass });
    identity.complete(identity.last(), dobYearsAgo(16));
    const checked = await post("/stranger/identity/check", { pass });
    expect(checked.body).toMatchObject({ age: "minor", eligible: false });
    // The minor result retires the pass on the spot.
    expect((await post("/stranger/identity/start", { pass })).status).toBe(401);
  });

  it("the identity webhook is signed with its own secret and settles the check", async () => {
    const pass = await passFor();
    await post("/stranger/consent", { pass, version: CONSENT_VERSION });
    await post("/stranger/identity/start", { pass });
    const id = identity.last();
    identity.complete(id, dobYearsAgo(40));
    const raw = JSON.stringify({
      id: "evt_vs_1",
      type: "identity.verification_session.verified",
      data: { object: { id, status: "verified", livemode: true, metadata: identity.sessions.get(id)!.metadata, url: null, last_error: null } },
    });
    expect((await post("/stripe/identity-webhook", raw, { "Stripe-Signature": signWebhookPayload(raw, "whsec_wrong") })).status).toBe(400);
    const ok = await post("/stripe/identity-webhook", raw, { "Stripe-Signature": signWebhookPayload(raw, "whsec_identity_fake") });
    expect(ok.status).toBe(200);
    expect((await post("/stranger/me", { pass })).body).toMatchObject({ age: "adult", eligible: true });
  });

  it("solo and invite play are untouched by stranger mode being on", async () => {
    const solo = await post("/game", { childName: "Solo", relationshipType: "solo parent", birthYear: 1990 });
    expect(solo.status).toBe(200);
  });
});
