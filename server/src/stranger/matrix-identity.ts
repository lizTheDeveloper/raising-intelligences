import { randomBytes } from "node:crypto";

/**
 * Who a stranger-mode player is: their Matrix account on
 * matrix.multiversegames.ai, proved with a short-lived OpenID token the
 * client gets from the homeserver (getOpenIdToken) and we check against
 * Synapse's userinfo endpoint. Nothing the client says about itself is used.
 */

const MATRIX_ID_RE = /^@[a-z0-9._=\-/+]{1,200}:[a-zA-Z0-9.\-]{1,200}$/;

export async function verifyOpenIdToken(token: unknown, userinfoUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > 512) return null;
  try {
    const res = await fetchImpl(`${userinfoUrl}?access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { sub?: unknown } | null;
    const sub = body?.sub;
    return typeof sub === "string" && MATRIX_ID_RE.test(sub) ? sub : null;
  } catch {
    return null;
  }
}

/** How long a stranger pass lasts: one meetup evening. */
export const PASS_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * A stranger pass: an unguessable bearer token standing for one verified
 * Matrix account, so the OpenID check runs once per evening rather than on
 * every request. Held in memory — a restart means signing in again.
 */
export class StrangerPasses {
  private passes = new Map<string, { subject: string; meetupCode: string | null; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(subject: string, meetupCode: string | null): string {
    this.sweep();
    const token = randomBytes(32).toString("base64url");
    this.passes.set(token, { subject, meetupCode, expiresAt: this.now() + PASS_TTL_MS });
    return token;
  }

  resolve(token: unknown): { subject: string; meetupCode: string | null } | null {
    if (typeof token !== "string" || token.length === 0) return null;
    const p = this.passes.get(token);
    if (!p) return null;
    if (p.expiresAt <= this.now()) {
      this.passes.delete(token);
      return null;
    }
    return { subject: p.subject, meetupCode: p.meetupCode };
  }

  /** Drop every pass for an account (a suspension, or a minor result). */
  revokeSubject(subject: string): void {
    for (const [t, p] of this.passes) if (p.subject === subject) this.passes.delete(t);
  }

  private sweep(): void {
    const now = this.now();
    for (const [t, p] of this.passes) if (p.expiresAt <= now) this.passes.delete(t);
  }
}
