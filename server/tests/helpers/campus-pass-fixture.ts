// Test-only campus pass signer: a fresh Ed25519 keypair per test run, never
// the campus private key (which only campus holds).
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";

export interface TestClaims { iss: string; sub: string; name: string; aud: string; iat: number; exp: number; jti: string }

export function newCampusKeyPair(): { publicKeyB64: string; privateKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyB64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

export function claimsFor(overrides: Partial<TestClaims> = {}, nowMs = Date.now()): TestClaims {
  const iat = Math.floor(nowMs / 1000);
  return {
    iss: "campus.themultiverse.school",
    sub: "@test-student:themultiverse.school",
    name: "Test Student",
    aud: "raising-intelligences",
    iat,
    exp: iat + 300,
    jti: randomBytes(16).toString("hex"),
    ...overrides,
  };
}

export function signPass(claims: object, privateKeyB64: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = sign(null, Buffer.from(payload, "ascii"), key).toString("base64url");
  return `cps.${payload}.${sig}`;
}
