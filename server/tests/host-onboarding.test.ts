import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HostHarness, ADMIN } from "./helpers/host-tools.js";
import { HOST_TERMS_VERSION } from "../src/hosts/terms.js";
import { HOST_CONSENT_VERSION, CONSENT_VERSION } from "../src/stranger/identity.js";

/**
 * Persona tests, Sister Jensen and Liz (S2-5): setting up a guest reader took
 * a throwaway event, sent her through a player card and the players' consent
 * screen, and left her on "come back to the same link". The admin record
 * also said she had signed an agreement nobody had shown her.
 *
 * Now the admin creates an invite. The person opens its link, signs in, passes
 * the same 18+ check as players (with copy written for hosts), agrees to the
 * host and reader terms (that agreement is what gets recorded), and lands on
 * their portal. Age verification stays mandatory. A person the admin adds
 * directly is asked to agree in the portal unless the admin records a signed
 * agreement.
 */

const JENSEN = "@jensen:multiversegames.ai";
const DAY = 24 * 3600 * 1000;
const NOT_AVAILABLE = "this invite isn't available.";

describe("host onboarding by invite", () => {
  let h: HostHarness;
  beforeEach(async () => { h = await new HostHarness({ clock: Date.now() }).boot(); });
  afterEach(async () => { await h.close(); });

  const invite = async (body: Record<string, unknown> = {}) => {
    const r = await h.post("/admin/host-tools/invites", { displayName: "Sister Jensen", hostType: "sensitive", organisation: "Riverside Ward", ...body }, ADMIN);
    expect(r.status).toBe(200);
    return r.body as { invite: { id: string }; token: string; link: string };
  };
  it("the admin makes an invite; its link carries a token shown once; the list shows it open", async () => {
    const r = await invite();
    expect(r.link).toMatch(new RegExp(`/\\?hostinvite=${r.token}$`));
    const list = await h.get("/admin/host-tools/invites", ADMIN);
    expect(list.body.invites).toHaveLength(1);
    expect(list.body.invites[0]).toMatchObject({ id: r.invite.id, displayName: "Sister Jensen", hostType: "sensitive", status: "open" });
    expect(JSON.stringify(list.body)).not.toContain(r.token);
    expect((await h.post("/admin/host-tools/invites", { displayName: "X" }, ADMIN)).status).toBe(400); // a host type is required
    expect((await h.post("/admin/host-tools/invites", { displayName: "X", hostType: "club" })).status).toBe(401);
  });

  it("the invite page: who it's for, the terms; anything else answers the same way", async () => {
    const { token } = await invite();
    const peek = await h.post("/host/invite/peek", { invite: token });
    expect(peek.status).toBe(200);
    expect(peek.body.displayName).toBe("Sister Jensen");
    expect(peek.body.terms.version).toBe(HOST_TERMS_VERSION);
    expect(peek.body.consentVersion).toBe(HOST_CONSENT_VERSION);
    const text = JSON.stringify(peek.body.terms);
    expect(text).toContain("you'll only open codes a pair gives you");
    expect(text).toContain("never ask an attendee whether they shared");
    const bad = await h.post("/host/invite/peek", { invite: "not-a-token" });
    expect([bad.status, bad.body]).toEqual([404, { error: NOT_AVAILABLE }]);
  });

  it("sign in, the host 18+ check, the terms, then the portal; the agreement recorded is the one she accepted", async () => {
    const { token, invite: inv } = await invite();
    const pass = await h.post("/host/invite/pass", { invite: token, openIdToken: `tok:${JENSEN}` });
    expect(pass.status).toBe(200);
    expect(pass.body).toMatchObject({ adult: false, consented: false });
    const ip2 = pass.body.invitePass as string;
    // No terms before the 18+ check.
    const early = await h.post("/host/invite/accept", { invitePass: ip2, termsVersion: HOST_TERMS_VERSION });
    expect(early.status).toBe(403);
    // The players' consent version isn't the host screen's.
    expect((await h.post("/host/invite/consent", { invitePass: ip2, version: CONSENT_VERSION })).status).toBe(400);
    expect((await h.post("/host/invite/consent", { invitePass: ip2, version: HOST_CONSENT_VERSION })).status).toBe(200);
    const start = await h.post("/host/invite/identity/start", { invitePass: ip2 });
    expect(start.status).toBe(200);
    expect(start.body.url).toMatch(/^https:\/\/verify\.stripe\.test\//);
    // Stripe's return URL brings her back to the invite, and carries no token.
    const fake = (h.stranger.age as unknown as { injectedApi: { created: Array<Record<string, unknown>> } }).injectedApi;
    const returnUrl = String(fake.created.at(-1)!.return_url);
    expect(returnUrl).toMatch(/\?hostinvite=back$/);
    expect(returnUrl).not.toContain(token);
    await h.verify(JENSEN);
    const checked = await h.post("/host/invite/identity/check", { invitePass: ip2 });
    expect(checked.body).toMatchObject({ adult: true, consented: true });
    // A stale terms version gets the current terms back.
    const stale = await h.post("/host/invite/accept", { invitePass: ip2, termsVersion: "host-terms-0" });
    expect(stale.status).toBe(409);
    expect(stale.body.terms.version).toBe(HOST_TERMS_VERSION);
    const ok = await h.post("/host/invite/accept", { invitePass: ip2, termsVersion: HOST_TERMS_VERSION });
    expect(ok.status).toBe(200);
    const people = (await h.get("/admin/host-tools/hosts", ADMIN)).body.people as any[];
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ displayName: "Sister Jensen", hostType: "sensitive", organisation: "Riverside Ward", status: "approved", agreementVersion: HOST_TERMS_VERSION, agreementAt: h.now() });
    // The portal is hers now.
    const hp = await h.post("/host/pass", { openIdToken: `tok:${JENSEN}` });
    expect(hp.status).toBe(200);
    expect((await h.post("/host/events", { pass: hp.body.pass })).body).toMatchObject({ displayName: "Sister Jensen", events: [] });
    // Used: the link answers like any other.
    expect((await h.post("/host/invite/peek", { invite: token })).body).toEqual({ error: NOT_AVAILABLE });
    expect((await h.post("/host/invite/accept", { invitePass: ip2, termsVersion: HOST_TERMS_VERSION })).status).toBe(404);
    expect((await h.get("/admin/host-tools/invites", ADMIN)).body.invites[0]).toMatchObject({ id: inv.id, status: "used", personName: "Sister Jensen" });
  });

  it("an adult who already passed the check goes straight to the terms; she never sees a player card or the queue", async () => {
    const { token } = await invite();
    await h.verify(JENSEN);
    const pass = await h.post("/host/invite/pass", { invite: token, openIdToken: `tok:${JENSEN}` });
    expect(pass.body).toMatchObject({ adult: true });
    expect((await h.post("/host/invite/accept", { invitePass: pass.body.invitePass, termsVersion: HOST_TERMS_VERSION })).status).toBe(200);
    // No meetup exists, and none was needed: her account page lists no meetups.
    const acct = await h.post("/stranger/account", { pass: (await h.post("/stranger/account/pass", { openIdToken: `tok:${JENSEN}` })).body.pass });
    expect(acct.body.meetups ?? []).toEqual([]);
  });

  it("a minor result ends it: no terms, no person", async () => {
    const { token } = await invite();
    await h.verify(JENSEN, "minor");
    const pass = await h.post("/host/invite/pass", { invite: token, openIdToken: `tok:${JENSEN}` });
    expect(pass.status).toBe(403);
    expect(pass.body.minor).toBe(true);
    expect((await h.get("/admin/host-tools/hosts", ADMIN)).body.people).toEqual([]);
  });

  it("expired after 14 days, or revoked: the same answer as a made-up token", async () => {
    const a = await invite();
    const b = await invite({ displayName: "Kofi", hostType: "club", organisation: undefined });
    expect((await h.post(`/admin/host-tools/invites/${b.invite.id}/revoke`, {}, ADMIN)).status).toBe(200);
    expect((await h.post("/host/invite/peek", { invite: b.token })).body).toEqual({ error: NOT_AVAILABLE });
    h.clock!.now += 15 * DAY;
    expect((await h.post("/host/invite/peek", { invite: a.token })).body).toEqual({ error: NOT_AVAILABLE });
    expect((await h.post("/host/invite/pass", { invite: a.token, openIdToken: `tok:${JENSEN}` })).status).toBe(404);
    const statuses = ((await h.get("/admin/host-tools/invites", ADMIN)).body.invites as any[]).map((i) => i.status).sort();
    expect(statuses).toEqual(["expired", "revoked"]);
  });

  it("an account that's already a host or reader is sent to its page, and the invite stays unused", async () => {
    await h.person(JENSEN, "Sister Jensen", { hostType: "sensitive" });
    const { token } = await invite();
    const pass = await h.post("/host/invite/pass", { invite: token, openIdToken: `tok:${JENSEN}` });
    expect(pass.status).toBe(409);
    expect(pass.body.error).toContain("already");
    expect((await h.post("/host/invite/peek", { invite: token })).status).toBe(200);
  });

  it("invite routes are hidden like everything else when host tools are off", async () => {
    const { token } = await invite();
    h.hostCfg = { ...h.hostCfg, enabled: false };
    expect((await h.post("/host/invite/peek", { invite: token })).text).toBe((await h.post("/never-built-path", {})).text);
  });
});

describe("a person the admin adds directly", () => {
  let h: HostHarness;
  beforeEach(async () => { h = await new HostHarness().boot(); });
  afterEach(async () => { await h.close(); });

  it("without a recorded signed agreement: no agreement on the record, and the portal asks first", async () => {
    await h.verify(JENSEN);
    const r = await h.post("/admin/host-tools/hosts", { matrixId: JENSEN, displayName: "Sister Jensen", hostType: "sensitive" }, ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.agreementAt).toBeNull();
    expect(r.body.agreementVersion).toBeNull();
    const pass = (await h.post("/host/pass", { openIdToken: `tok:${JENSEN}` })).body.pass as string;
    const ev = await h.post("/host/events", { pass });
    expect(ev.status).toBe(200);
    expect(ev.body.needsAgreement).toBe(true);
    expect(ev.body.terms.version).toBe(HOST_TERMS_VERSION);
    expect(ev.body.events).toEqual([]);
    expect((await h.post("/host/codes/list", { pass })).status).toBe(403);
    expect((await h.post("/host/agree", { pass, version: "nope" })).status).toBe(409);
    expect((await h.post("/host/agree", { pass, version: HOST_TERMS_VERSION })).status).toBe(200);
    const after = await h.post("/host/events", { pass });
    expect(after.body.needsAgreement).toBeUndefined();
    const person = (await h.get("/admin/host-tools/hosts", ADMIN)).body.people[0];
    expect(person.agreementVersion).toBe(HOST_TERMS_VERSION);
    expect(typeof person.agreementAt).toBe("number");
  });

  it("with a signed agreement recorded by the admin: its version and the time she recorded it", async () => {
    await h.verify(JENSEN);
    const r = await h.post("/admin/host-tools/hosts", { matrixId: JENSEN, displayName: "Sister Jensen", hostType: "sensitive", agreementSigned: true, agreementVersion: "paper-2026-11" }, ADMIN);
    expect(r.body.agreementVersion).toBe("paper-2026-11");
    expect(typeof r.body.agreementAt).toBe("number");
    const pass = (await h.post("/host/pass", { openIdToken: `tok:${JENSEN}` })).body.pass as string;
    expect((await h.post("/host/events", { pass })).body.needsAgreement).toBeUndefined();
  });

  it("the 18+ check is still required for a direct add, and the message points at the invite", async () => {
    const r = await h.post("/admin/host-tools/hosts", { matrixId: JENSEN, displayName: "Sister Jensen", hostType: "sensitive" }, ADMIN);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("invite");
  });
});
