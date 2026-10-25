import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * At-rest encryption for child-safety evidence: AES-256-GCM with a key read
 * from CHILD_SAFETY_EVIDENCE_KEY (32 random bytes, base64). The key lives in
 * VaultWarden ("RI child-safety evidence key") and the container env, never
 * in code or the database.
 *
 * Stored form: base64(iv[12] | tag[16] | ciphertext), plus a key id (first 16
 * hex chars of sha256(key)) so a rotated key can be told apart from a
 * corrupted row.
 *
 * With no key configured the vault still records the evidence: losing it
 * would be worse than storing it unencrypted in the restricted schema. Such
 * rows carry key id "none" and the caller reports the misconfiguration loudly.
 */

export const NO_KEY_ID = "none";

function loadKey(): Buffer | null {
  const raw = process.env.CHILD_SAFETY_EVIDENCE_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("CHILD_SAFETY_EVIDENCE_KEY must be 32 bytes, base64-encoded");
  }
  return key;
}

function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function evidenceKeyConfigured(): boolean {
  return !!process.env.CHILD_SAFETY_EVIDENCE_KEY;
}

export function encryptEvidence(plaintext: string): { keyId: string; ciphertext: string } {
  const key = loadKey();
  if (!key) {
    return { keyId: NO_KEY_ID, ciphertext: Buffer.from(plaintext, "utf8").toString("base64") };
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { keyId: keyIdOf(key), ciphertext: Buffer.concat([iv, tag, body]).toString("base64") };
}

export function decryptEvidence(keyId: string, ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  if (keyId === NO_KEY_ID) return buf.toString("utf8");
  const key = loadKey();
  if (!key) throw new Error("evidence is encrypted but CHILD_SAFETY_EVIDENCE_KEY is not set");
  if (keyIdOf(key) !== keyId) {
    throw new Error(`evidence was encrypted with key ${keyId}; the configured key is ${keyIdOf(key)}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
