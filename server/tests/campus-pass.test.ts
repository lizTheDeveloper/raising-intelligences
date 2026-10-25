import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPrivateKey, sign } from "node:crypto";
import {
  CAMPUS_PASS_PUBLIC_KEY,
  campusPassPublicKey,
  checkCampusPass,
  verifyCampusPass,
} from "../src/security/campus-pass.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { claimsFor, newCampusKeyPair, signPass } from "./helpers/campus-pass-fixture.js";

const AUD = "raising-intelligences";
const keys = newCampusKeyPair();
const other = newCampusKeyPair();
let store = new InMemoryGameRepository();
const opts = (nowMs?: number) => ({ publicKeyB64: keys.publicKeyB64, audience: AUD, nowMs });
const verify = (t: string, o: { publicKeyB64?: string; audience: string; nowMs?: number }) => verifyCampusPass(t, { ...o, jtiStore: store });

describe("verifyCampusPass", () => {
  beforeEach(() => { store = new InMemoryGameRepository(); });

  it("accepts a valid pass and returns sub, name and jti", async () => {
    const c = claimsFor();
    expect(await verify(signPass(c, keys.privateKeyB64), opts())).toEqual({ sub: c.sub, name: c.name, jti: c.jti });
  });

  it("refuses a pass signed by another key", async () => {
    expect(await verify(signPass(claimsFor(), other.privateKeyB64), opts())).toBeNull();
  });

  it("refuses a tampered claims segment", async () => {
    const pass = signPass(claimsFor(), keys.privateKeyB64);
    const [, payload, sig] = pass.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), sub: "@other:themultiverse.school" })).toString("base64url");
    expect(await verify(`cps.${forged}.${sig}`, opts())).toBeNull();
  });

  it("refuses the wrong audience and the wrong issuer", async () => {
    expect(await verify(signPass(claimsFor({ aud: "whispers" }), keys.privateKeyB64), opts())).toBeNull();
    expect(await verify(signPass(claimsFor({ iss: "evil.example" }), keys.privateKeyB64), opts())).toBeNull();
  });

  it("refuses an expired pass, and one whose lifetime exceeds 300 s", async () => {
    const now = Date.now();
    const expired = claimsFor({}, now - 301_000);
    expect(await verify(signPass(expired, keys.privateKeyB64), opts(now))).toBeNull();
    const c = claimsFor({}, now);
    expect(await verify(signPass({ ...c, exp: c.iat + 301 }, keys.privateKeyB64), opts(now))).toBeNull();
    // exactly at exp is expired (now < exp is required)
    expect(await verify(signPass(c, keys.privateKeyB64), opts(c.exp * 1000))).toBeNull();
  });

  it("allows ≤30 s of clock skew on iat only", async () => {
    const now = Date.now();
    const iat = Math.floor(now / 1000) + 30;
    expect(await verify(signPass(claimsFor({ iat, exp: iat + 300 }), keys.privateKeyB64), opts(now))).not.toBeNull();
    const iat2 = Math.floor(now / 1000) + 31;
    expect(await verify(signPass(claimsFor({ iat: iat2, exp: iat2 + 300 }), keys.privateKeyB64), opts(now))).toBeNull();
  });

  it("refuses non-integer iat/exp", async () => {
    const c = claimsFor();
    expect(await verify(signPass({ ...c, iat: c.iat + 0.5 }, keys.privateKeyB64), opts())).toBeNull();
    expect(await verify(signPass({ ...c, exp: String(c.exp) }, keys.privateKeyB64), opts())).toBeNull();
  });

  it("refuses a bad sub (wrong server, uppercase, empty localpart)", async () => {
    for (const sub of ["@x:matrix.org", "@Upper:themultiverse.school", "@:themultiverse.school", "x:themultiverse.school", "@x:themultiverse.school.evil"]) {
      expect(await verify(signPass(claimsFor({ sub }), keys.privateKeyB64), opts())).toBeNull();
    }
  });

  it("refuses a bad jti and a name over 100 characters", async () => {
    expect(await verify(signPass(claimsFor({ jti: "ABCDEF" + "0".repeat(26) }), keys.privateKeyB64), opts())).toBeNull();
    expect(await verify(signPass(claimsFor({ name: "n".repeat(101) }), keys.privateKeyB64), opts())).toBeNull();
    expect(await verify(signPass({ ...claimsFor(), name: 7 }, keys.privateKeyB64), opts())).toBeNull();
  });

  it("checkCampusPass is pure: it never consumes the jti", async () => {
    const pass = signPass(claimsFor(), keys.privateKeyB64);
    expect(checkCampusPass(pass, opts())).not.toBeNull();
    expect(checkCampusPass(pass, opts())).not.toBeNull();
    expect(await verify(pass, opts())).not.toBeNull();
  });

  it("a pass failing any other check never spends its jti", async () => {
    const c = claimsFor({ aud: "whispers" });
    expect(await verify(signPass(c, keys.privateKeyB64), opts())).toBeNull();
    expect(await verify(signPass({ ...c, aud: AUD }, keys.privateKeyB64), opts())).not.toBeNull();
  });

  it("refuses a replayed jti until it expires, and forgets it after", async () => {
    const now = Date.now();
    const c = claimsFor({}, now);
    const pass = signPass(c, keys.privateKeyB64);
    expect(await verify(pass, opts(now))).not.toBeNull();
    expect(await verify(pass, opts(now + 1000))).toBeNull();
    // A different pass reusing the jti is refused too.
    expect(await verify(signPass({ ...claimsFor({}, now), jti: c.jti }, keys.privateKeyB64), opts(now + 2000))).toBeNull();
    // Once the pass has expired the stored jti is pruned.
    expect(await store.consumeCampusPassJti(c.jti, (c.exp + 300) * 1000, c.exp * 1000 + 1)).toBe(true);
  });

  it("refuses malformed tokens", async () => {
    const good = signPass(claimsFor(), keys.privateKeyB64);
    const [, payload, sig] = good.split(".");
    for (const t of [
      "", "cps.", "cps..", `cps.${payload}`, `xps.${payload}.${sig}`, `cps.${payload}.${sig}.extra`,
      `cps.${payload}.${sig}=`, `cps.${payload}+.${sig}`, `cps.${Buffer.from("not json").toString("base64url")}.${sig}`,
      42 as unknown as string, null as unknown as string,
    ]) {
      expect(await verify(t, opts())).toBeNull();
    }
  });

  it("refuses claims that are valid JSON but not an object", async () => {
    const key = createPrivateKey({ key: Buffer.from(keys.privateKeyB64, "base64"), format: "der", type: "pkcs8" });
    const payload = Buffer.from("[1,2]").toString("base64url");
    const sig = sign(null, Buffer.from(payload, "ascii"), key).toString("base64url");
    expect(await verify(`cps.${payload}.${sig}`, opts())).toBeNull();
  });
});

describe("campus pass public key", () => {
  const saved = process.env.CAMPUS_PASS_PUBLIC_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.CAMPUS_PASS_PUBLIC_KEY;
    else process.env.CAMPUS_PASS_PUBLIC_KEY = saved;
  });

  it("is pinned to the contract's key by default", async () => {
    delete process.env.CAMPUS_PASS_PUBLIC_KEY;
    expect(CAMPUS_PASS_PUBLIC_KEY).toBe("MCowBQYDK2VwAyEAdlhCkIVpnYHxsbzstbzg2DLS7x9Br8dhqCIFtoZuBXU=");
    expect(campusPassPublicKey()).toBe(CAMPUS_PASS_PUBLIC_KEY);
  });

  it("can be overridden by CAMPUS_PASS_PUBLIC_KEY, and the override is used when none is passed", async () => {
    store = new InMemoryGameRepository();
    process.env.CAMPUS_PASS_PUBLIC_KEY = keys.publicKeyB64;
    expect(campusPassPublicKey()).toBe(keys.publicKeyB64);
    expect(await verify(signPass(claimsFor(), keys.privateKeyB64), { audience: AUD })).not.toBeNull();
  });
});
