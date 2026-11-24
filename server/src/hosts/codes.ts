import { createHmac, randomBytes, randomInt } from "node:crypto";
import { WORDS } from "./wordlist.js";

/**
 * Codes and opaque references. Nothing here is ever stored in the clear:
 * - an event code is shown to the admin once, then kept only as a keyed hash;
 * - a share code's words are derived from a server secret and the code's row
 *   id, so they can be shown again to the pair without being stored, and are
 *   looked up by a keyed hash;
 * - the refs handed to a browser (gameRef, codeRef, eventRef) are keyed per
 *   caller, so one person's ref means nothing to anyone else (H11).
 */

const hmac = (key: string, msg: string) => createHmac("sha256", key).update(msg).digest();

/** Lower-case words separated by single spaces or hyphens; anything else is not a code. */
export function normalizeWords(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parts = raw.trim().toLowerCase().split(/[\s\-_.,]+/).filter(Boolean);
  if (parts.length !== 4 || parts.some((w) => !/^[a-z]{2,12}$/.test(w))) return null;
  return parts.join(" ");
}

/** Four words from 44 bits. */
function wordsFrom(bytes: Buffer): string[] {
  let bits = 0n;
  for (const b of bytes.subarray(0, 6)) bits = (bits << 8n) | BigInt(b);
  bits >>= 4n; // 48 → 44 bits
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    out.unshift(WORDS[Number(bits & 2047n)]);
    bits >>= 11n;
  }
  return out;
}

/** A share code's words, derived (never stored) from the secret and its row id. */
export function deriveShareWords(secret: string, codeId: string): string {
  return wordsFrom(hmac(secret, `share-code:${codeId}`)).join(" ");
}

/** A fresh event code: four random words joined with hyphens (a valid ?meetup= value). */
export function newEventCode(): string {
  const out: string[] = [];
  for (let i = 0; i < 4; i++) out.push(WORDS[randomInt(WORDS.length)]);
  return out.join("-");
}

/** The keyed hash an event code is stored and looked up by. */
export function eventCodeHash(pepper: string, normalizedCode: string): string {
  return hmac(pepper, `event-code:${normalizedCode}`).toString("hex");
}

/** The keyed hash a share code is stored and looked up by. */
export function shareCodeHash(pepper: string, normalizedWords: string): string {
  return hmac(pepper, `share-code-words:${normalizedWords}`).toString("hex");
}

/** The pre-subject token handed back for an acknowledgement, and its stored hash. */
export function newAckToken(): string {
  return randomBytes(24).toString("base64url");
}
export function ackTokenHash(pepper: string, token: string): string {
  return hmac(pepper, `ack:${token}`).toString("hex");
}

/** An opaque reference to `id`, meaningful only to `viewer`. */
export function opaqueRef(pepper: string, kind: "game" | "code" | "event", viewer: string, id: string): string {
  return hmac(pepper, `ref:${kind}:${viewer}:${id}`).subarray(0, 18).toString("base64url");
}
