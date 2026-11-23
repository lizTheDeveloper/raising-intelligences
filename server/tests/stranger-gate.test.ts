import { describe, it, expect, beforeEach } from "vitest";
import { readStrangerConfig, strangerVisible, normalizeMeetupCode } from "../src/stranger/config.js";
import { AgeVerification, ageOn, CONSENT_VERSION } from "../src/stranger/identity.js";
import { InMemoryStrangerStore } from "../src/stranger/store.js";
import { StrangerPasses, verifyOpenIdToken } from "../src/stranger/matrix-identity.js";
import { InMemoryChildSafetyStore } from "../src/safety/child-safety/store.js";
import { FakeIdentity, strangerConfig, dobYearsAgo } from "./helpers/fake-identity.js";
import type { StrangerConfig } from "../src/stranger/config.js";

const ALICE = "@alice:multiversegames.ai";

describe("stranger mode switch", () => {
  it("is off by default and in every unknown value", () => {
    expect(readStrangerConfig({} as NodeJS.ProcessEnv).mode).toBe("off");
    expect(readStrangerConfig({ RI_STRANGER_MODE: "true" } as NodeJS.ProcessEnv).mode).toBe("off");
    expect(readStrangerConfig({ RI_STRANGER_MODE: "ON" } as NodeJS.ProcessEnv).mode).toBe("off");
  });

  it("off: never visible, with or without a code", () => {
    const cfg = readStrangerConfig({ RI_STRANGER_MODE: "off", RI_MEETUP_CODES: "tea-party" } as NodeJS.ProcessEnv);
    expect(strangerVisible(cfg, "tea-party")).toBe(false);
    expect(strangerVisible(cfg, undefined)).toBe(false);
  });

  it("meetup: only with a listed code", () => {
    const cfg = readStrangerConfig({ RI_STRANGER_MODE: "meetup", RI_MEETUP_CODES: " Tea-Party , book-club" } as NodeJS.ProcessEnv);
    expect(strangerVisible(cfg, "tea-party")).toBe(true);
    expect(strangerVisible(cfg, "TEA-PARTY")).toBe(true);
    expect(strangerVisible(cfg, "book-club")).toBe(true);
    expect(strangerVisible(cfg, "tea")).toBe(false);
    expect(strangerVisible(cfg, "")).toBe(false);
    expect(strangerVisible(cfg, undefined)).toBe(false);
  });

  it("meetup with no codes configured is effectively off", () => {
    const cfg = readStrangerConfig({ RI_STRANGER_MODE: "meetup" } as NodeJS.ProcessEnv);
    expect(strangerVisible(cfg, "anything")).toBe(false);
  });

  it("public: visible to everyone", () => {
    const cfg = readStrangerConfig({ RI_STRANGER_MODE: "public" } as NodeJS.ProcessEnv);
    expect(strangerVisible(cfg, undefined)).toBe(true);
  });

  it("normalizes codes and rejects junk", () => {
    expect(normalizeMeetupCode(" Tea-Party ")).toBe("tea-party");
    expect(normalizeMeetupCode("a b")).toBeNull();
    expect(normalizeMeetupCode("<script>")).toBeNull();
    expect(normalizeMeetupCode(42)).toBeNull();
  });

  it("test-mode identity is never allowed in production, whatever the env says", () => {
    const prod = readStrangerConfig({ NODE_ENV: "production", RI_STRANGER_ALLOW_TEST_IDENTITY: "true" } as NodeJS.ProcessEnv);
    expect(prod.allowTestIdentity).toBe(false);
    const dev = readStrangerConfig({ NODE_ENV: "development", RI_STRANGER_ALLOW_TEST_IDENTITY: "true" } as NodeJS.ProcessEnv);
    expect(dev.allowTestIdentity).toBe(true);
    expect(readStrangerConfig({} as NodeJS.ProcessEnv).allowTestIdentity).toBe(false);
  });
});

describe("age arithmetic", () => {
  const now = new Date(Date.UTC(2026, 10, 22));
  it("counts birthdays exactly", () => {
    expect(ageOn({ year: 2008, month: 11, day: 22 }, now)).toBe(18);
    expect(ageOn({ year: 2008, month: 11, day: 23 }, now)).toBe(17);
    expect(ageOn({ year: 2008, month: 12, day: 1 }, now)).toBe(17);
    expect(ageOn({ year: 1990, month: 1, day: 1 }, now)).toBe(36);
  });
  it("a 29 February birthday turns over on 1 March in a non-leap year", () => {
    expect(ageOn({ year: 2008, month: 2, day: 29 }, new Date(Date.UTC(2026, 1, 28)))).toBe(17);
    expect(ageOn({ year: 2008, month: 2, day: 29 }, new Date(Date.UTC(2026, 2, 1)))).toBe(18);
  });
});

describe("Matrix identity", () => {
  it("returns the sub only for a valid Matrix id from the homeserver", async () => {
    const ok = (async () => new Response(JSON.stringify({ sub: ALICE }), { status: 200 })) as typeof fetch;
    expect(await verifyOpenIdToken("tok", "https://hs/userinfo", ok)).toBe(ALICE);
    const bad = (async () => new Response(JSON.stringify({ errcode: "M_UNKNOWN_TOKEN" }), { status: 401 })) as typeof fetch;
    expect(await verifyOpenIdToken("tok", "https://hs/userinfo", bad)).toBeNull();
    const junk = (async () => new Response(JSON.stringify({ sub: "not-an-mxid" }), { status: 200 })) as typeof fetch;
    expect(await verifyOpenIdToken("tok", "https://hs/userinfo", junk)).toBeNull();
    const boom = (async () => { throw new Error("down"); }) as typeof fetch;
    expect(await verifyOpenIdToken("tok", "https://hs/userinfo", boom)).toBeNull();
    expect(await verifyOpenIdToken("", "https://hs/userinfo", ok)).toBeNull();
  });

  it("passes resolve to their subject, expire, and can't be guessed", () => {
    let now = 1_000_000;
    const passes = new StrangerPasses(() => now);
    const token = passes.issue(ALICE, "tea-party");
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(passes.resolve(token)).toEqual({ subject: ALICE, meetupCode: "tea-party" });
    expect(passes.resolve(token + "x")).toBeNull();
    expect(passes.resolve("")).toBeNull();
    now += 13 * 60 * 60 * 1000;
    expect(passes.resolve(token)).toBeNull();
  });
});

describe("age verification (Stripe Identity)", () => {
  let store: InMemoryStrangerStore;
  let identity: FakeIdentity;
  let cfg: StrangerConfig;
  let childSafety: InMemoryChildSafetyStore;
  let av: AgeVerification;

  beforeEach(() => {
    store = new InMemoryStrangerStore();
    identity = new FakeIdentity();
    cfg = strangerConfig();
    childSafety = new InMemoryChildSafetyStore();
    av = new AgeVerification({ store, api: identity, config: () => cfg, childSafety });
  });

  async function verifyAs(mxid: string, dob: { day: number; month: number; year: number } | null) {
    await av.recordConsent(mxid, CONSENT_VERSION);
    const started = await av.start(mxid, null);
    expect("url" in started).toBe(true);
    identity.complete(identity.last(), dob);
    return av.check(mxid);
  }

  it("will not start a check without the biometric consent recorded first", async () => {
    const r = await av.start(ALICE, null);
    expect("url" in r).toBe(false);
    expect(identity.created).toHaveLength(0);
  });

  it("asks Stripe for a document plus a matching live selfie", async () => {
    await av.recordConsent(ALICE, CONSENT_VERSION);
    await av.start(ALICE, "tea-party");
    const p = identity.created[0];
    expect(p.type).toBe("document");
    expect(p["options[document][require_matching_selfie]"]).toBe(true);
    expect(p["options[document][require_live_capture]"]).toBe(true);
    // No Matrix id or name goes to Stripe — only an opaque hash.
    expect(JSON.stringify(p)).not.toContain("alice");
    expect(String(p.return_url)).toContain("meetup=tea-party");
  });

  it("an adult passes; the stored row has no date of birth", async () => {
    expect(await verifyAs(ALICE, dobYearsAgo(30))).toBe("adult");
    expect((await av.adultForPool(ALICE)).ok).toBe(true);
    const row = await store.getVerification(await av.subjectHash(ALICE));
    expect(row).toMatchObject({ outcome: "adult", livemode: true });
    expect(JSON.stringify(row)).not.toMatch(/dob|day|month|year/i);
    expect(identity.redacted).toHaveLength(1);
  });

  it("18 today passes; 18 tomorrow is a minor", async () => {
    expect(await verifyAs(ALICE, dobYearsAgo(18))).toBe("adult");
    expect(await verifyAs("@bob:multiversegames.ai", dobYearsAgo(18, 1))).toBe("minor");
    expect((await av.adultForPool("@bob:multiversegames.ai")).ok).toBe(false);
  });

  it("a minor result blocks the account: no retry, no pool", async () => {
    expect(await verifyAs(ALICE, dobYearsAgo(15))).toBe("minor");
    await av.recordConsent(ALICE, CONSENT_VERSION);
    const again = await av.start(ALICE, null);
    expect("url" in again).toBe(false);
    expect((await av.adultForPool(ALICE)).reason).toBe("minor");
  });

  it("a verified check with no readable date of birth is not adult", async () => {
    expect(await verifyAs(ALICE, null)).toBe("unverified");
    expect((await av.adultForPool(ALICE)).ok).toBe(false);
  });

  it("an unfinished check is not adult", async () => {
    await av.recordConsent(ALICE, CONSENT_VERSION);
    await av.start(ALICE, null);
    expect(await av.check(ALICE)).toBe("unverified");
    identity.fail(identity.last());
    expect(await av.check(ALICE)).toBe("unverified");
    expect((await av.adultForPool(ALICE)).ok).toBe(false);
  });

  it("a TEST-mode verification never admits anyone in production", async () => {
    identity.livemode = false;
    expect(await verifyAs(ALICE, dobYearsAgo(30))).toBe("adult");
    const r = await av.adultForPool(ALICE);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("test_mode_verification");
  });

  it("outside production, test-mode checks count only when explicitly allowed", async () => {
    identity.livemode = false;
    cfg = strangerConfig({ production: false, allowTestIdentity: true });
    expect(await verifyAs(ALICE, dobYearsAgo(30))).toBe("adult");
    expect((await av.adultForPool(ALICE)).ok).toBe(true);
  });

  it("an adult banned by a child-safety case is refused", async () => {
    expect(await verifyAs(ALICE, dobYearsAgo(30))).toBe("adult");
    await childSafety.banIdentifier({ kind: "matrix", value: ALICE }, "confirmed case", null);
    const r = await av.adultForPool(ALICE);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("banned");
  });

  it("limits how many checks one account can start in a day", async () => {
    await av.recordConsent(ALICE, CONSENT_VERSION);
    for (let i = 0; i < 3; i++) expect("url" in (await av.start(ALICE, null))).toBe(true);
    expect("url" in (await av.start(ALICE, null))).toBe(false);
  });

  it("only a check started for this account counts for it", async () => {
    await av.recordConsent(ALICE, CONSENT_VERSION);
    await av.start(ALICE, null);
    identity.complete(identity.last(), dobYearsAgo(30));
    // Bob never started one; Alice's session can't verify him.
    expect(await av.check("@bob:multiversegames.ai")).toBe("unverified");
    expect((await av.adultForPool("@bob:multiversegames.ai")).ok).toBe(false);
  });

  it("the webhook path settles the same way as the return path", async () => {
    await av.recordConsent(ALICE, CONSENT_VERSION);
    await av.start(ALICE, null);
    const id = identity.last();
    identity.complete(id, dobYearsAgo(40));
    await av.applyWebhookSession({ id, status: "verified", livemode: true, metadata: identity.sessions.get(id)!.metadata, url: null, last_error: null });
    expect((await av.adultForPool(ALICE)).ok).toBe(true);
  });
});
