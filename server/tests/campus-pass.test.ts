import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPrivateKey, sign } from "node:crypto";
import {
  CAMPUS_PASS_PUBLIC_KEY,
  campusPassPublicKey,
  resetSeenJtis,
  verifyCampusPass,
} from "../src/security/campus-pass.js";
import { claimsFor, newCampusKeyPair, signPass } from "./helpers/campus-pass-fixture.js";

const AUD = "raising-intelligences";
const keys = newCampusKeyPair();
const other = newCampusKeyPair();
const opts = (nowMs?: number) => ({ publicKeyB64: keys.publicKeyB64, audience: AUD, nowMs });

describe("verifyCampusPass", () => {
  beforeEach(() => resetSeenJtis());

  it("accepts a valid pass and returns sub, name and jti", () => {
    const c = claimsFor();
    expect(verifyCampusPass(signPass(c, keys.privateKeyB64), opts())).toEqual({ sub: c.sub, name: c.name, jti: c.jti });
  });

  it("refuses a pass signed by another key", () => {
    expect(verifyCampusPass(signPass(claimsFor(), other.privateKeyB64), opts())).toBeNull();
  });

  it("refuses a tampered claims segment", () => {
    const pass = signPass(claimsFor(), keys.privateKeyB64);
    const [, payload, sig] = pass.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), sub: "@other:themultiverse.school" })).toString("base64url");
    expect(verifyCampusPass(`cps.${forged}.${sig}`, opts())).toBeNull();
  });

  it("refuses the wrong audience and the wrong issuer", () => {
    expect(verifyCampusPass(signPass(claimsFor({ aud: "whispers" }), keys.privateKeyB64), opts())).toBeNull();
    expect(verifyCampusPass(signPass(claimsFor({ iss: "evil.example" }), keys.privateKeyB64), opts())).toBeNull();
  });

  it("refuses an expired pass, and one whose lifetime exceeds 300 s", () => {
    const now = Date.now();
    const expired = claimsFor({}, now - 301_000);
    expect(verifyCampusPass(signPass(expired, keys.privateKeyB64), opts(now))).toBeNull();
    const c = claimsFor({}, now);
    expect(verifyCampusPass(signPass({ ...c, exp: c.iat + 301 }, keys.privateKeyB64), opts(now))).toBeNull();
    // exactly at exp is expired (now < exp is required)
    expect(verifyCampusPass(signPass(c, keys.privateKeyB64), opts(c.exp * 1000))).toBeNull();
  });

  it("allows ≤30 s of clock skew on iat only", () => {
    const now = Date.now();
    const iat = Math.floor(now / 1000) + 30;
    expect(verifyCampusPass(signPass(claimsFor({ iat, exp: iat + 300 }), keys.privateKeyB64), opts(now))).not.toBeNull();
    const iat2 = Math.floor(now / 1000) + 31;
    expect(verifyCampusPass(signPass(claimsFor({ iat: iat2, exp: iat2 + 300 }), keys.privateKeyB64), opts(now))).toBeNull();
  });

  it("refuses non-integer iat/exp", () => {
    const c = claimsFor();
    expect(verifyCampusPass(signPass({ ...c, iat: c.iat + 0.5 }, keys.privateKeyB64), opts())).toBeNull();
    expect(verifyCampusPass(signPass({ ...c, exp: String(c.exp) }, keys.privateKeyB64), opts())).toBeNull();
  });

  it("refuses a bad sub (wrong server, uppercase, empty localpart)", () => {
    for (const sub of ["@x:matrix.org", "@Upper:themultiverse.school", "@:themultiverse.school", "x:themultiverse.school", "@x:themultiverse.school.evil"]) {
      expect(verifyCampusPass(signPass(claimsFor({ sub }), keys.privateKeyB64), opts())).toBeNull();
    }
  });

  it("refuses a bad jti and a name over 100 characters", () => {
    expect(verifyCampusPass(signPass(claimsFor({ jti: "ABCDEF" + "0".repeat(26) }), keys.privateKeyB64), opts())).toBeNull();
    expect(verifyCampusPass(signPass(claimsFor({ name: "n".repeat(101) }), keys.privateKeyB64), opts())).toBeNull();
    expect(verifyCampusPass(signPass({ ...claimsFor(), name: 7 }, keys.privateKeyB64), opts())).toBeNull();
  });

  it("refuses a replayed jti until it expires, and forgets it after", () => {
    const now = Date.now();
    const c = claimsFor({}, now);
    const pass = signPass(c, keys.privateKeyB64);
    expect(verifyCampusPass(pass, opts(now))).not.toBeNull();
    expect(verifyCampusPass(pass, opts(now + 1000))).toBeNull();
    // A different pass reusing the jti is refused too.
    expect(verifyCampusPass(signPass({ ...claimsFor({}, now), jti: c.jti }, keys.privateKeyB64), opts(now + 2000))).toBeNull();
  });

  it("refuses malformed tokens", () => {
    const good = signPass(claimsFor(), keys.privateKeyB64);
    const [, payload, sig] = good.split(".");
    for (const t of [
      "", "cps.", "cps..", `cps.${payload}`, `xps.${payload}.${sig}`, `cps.${payload}.${sig}.extra`,
      `cps.${payload}.${sig}=`, `cps.${payload}+.${sig}`, `cps.${Buffer.from("not json").toString("base64url")}.${sig}`,
      42 as unknown as string, null as unknown as string,
    ]) {
      expect(verifyCampusPass(t, opts())).toBeNull();
    }
  });

  it("refuses claims that are valid JSON but not an object", () => {
    const key = createPrivateKey({ key: Buffer.from(keys.privateKeyB64, "base64"), format: "der", type: "pkcs8" });
    const payload = Buffer.from("[1,2]").toString("base64url");
    const sig = sign(null, Buffer.from(payload, "ascii"), key).toString("base64url");
    expect(verifyCampusPass(`cps.${payload}.${sig}`, opts())).toBeNull();
  });
});

describe("campus pass public key", () => {
  const saved = process.env.CAMPUS_PASS_PUBLIC_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.CAMPUS_PASS_PUBLIC_KEY;
    else process.env.CAMPUS_PASS_PUBLIC_KEY = saved;
  });

  it("is pinned to the contract's key by default", () => {
    delete process.env.CAMPUS_PASS_PUBLIC_KEY;
    expect(CAMPUS_PASS_PUBLIC_KEY).toBe("MCowBQYDK2VwAyEAdlhCkIVpnYHxsbzstbzg2DLS7x9Br8dhqCIFtoZuBXU=");
    expect(campusPassPublicKey()).toBe(CAMPUS_PASS_PUBLIC_KEY);
  });

  it("can be overridden by CAMPUS_PASS_PUBLIC_KEY, and the override is used when none is passed", () => {
    resetSeenJtis();
    process.env.CAMPUS_PASS_PUBLIC_KEY = keys.publicKeyB64;
    expect(campusPassPublicKey()).toBe(keys.publicKeyB64);
    expect(verifyCampusPass(signPass(claimsFor(), keys.privateKeyB64), { audience: AUD })).not.toBeNull();
  });
});
