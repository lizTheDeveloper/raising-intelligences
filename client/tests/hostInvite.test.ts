import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOST_INVITE_KEY,
  asInvitePeek,
  asTerms,
  hostInviteRoute,
  loadInvite,
  saveInvite,
} from "../src/hostInvite.js";
import { asPortalEvents } from "../src/hostPortal.js";
import { untrackedLanding } from "../src/meetupCard.js";

class Mem {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

const TERMS = { version: "host-terms-1", sections: [{ heading: "what you agree to", bullets: ["one.", "two."] }] };

test("?hostinvite=<token> is an invite; ?hostinvite=back is the return from the ID check; anything else isn't", () => {
  assert.deepEqual(hostInviteRoute("?hostinvite=abcdefghijklmnopqrstuvwx"), { token: "abcdefghijklmnopqrstuvwx" });
  assert.deepEqual(hostInviteRoute("?hostinvite=back"), { back: true });
  assert.equal(hostInviteRoute("?hostinvite="), null);
  assert.equal(hostInviteRoute("?host=1"), null);
  assert.equal(hostInviteRoute(""), null);
});

test("an invite page is never tracked, like the portal", () => {
  assert.equal(untrackedLanding("?hostinvite=abcdefghijklmnopqrstuvwx"), true);
  assert.equal(untrackedLanding("?hostinvite=back"), true);
});

test("the invite token and its pass live in this tab only, and clear together", () => {
  const s = new Mem();
  saveInvite({ token: "tok", invitePass: "ip" }, s);
  assert.deepEqual(loadInvite(s), { token: "tok", invitePass: "ip" });
  saveInvite({ token: "tok", invitePass: null }, s);
  assert.deepEqual(loadInvite(s), { token: "tok", invitePass: null });
  saveInvite(null, s);
  assert.equal(loadInvite(s), null);
  assert.equal(s.m.size, 0);
  s.setItem(HOST_INVITE_KEY, "not json");
  assert.equal(loadInvite(s), null);
  assert.equal(loadInvite(null), null);
});

test("terms: a version and headed bullet lists, or nothing", () => {
  assert.deepEqual(asTerms(TERMS), TERMS);
  assert.equal(asTerms({ version: "x", sections: [] }), null);
  assert.equal(asTerms({ version: "x", sections: [{ heading: "h", bullets: [3] }] }), null);
  assert.equal(asTerms(null), null);
});

test("the invite peek: who it's for, the terms and the consent version", () => {
  assert.deepEqual(asInvitePeek({ displayName: "Sister Jensen", hostType: "sensitive", terms: TERMS, consentVersion: "host-1" }), {
    displayName: "Sister Jensen", terms: TERMS, consentVersion: "host-1",
  });
  assert.equal(asInvitePeek({ error: "this invite isn't available." }), null);
});

test("the portal's list carries the terms when the person still has to agree", () => {
  const p = asPortalEvents({ displayName: "Sister Jensen", needsAgreement: true, terms: TERMS, events: [] });
  assert.deepEqual(p?.needsAgreement, TERMS);
  assert.equal(asPortalEvents({ displayName: "Kofi", events: [] })?.needsAgreement, undefined);
});
