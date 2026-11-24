/**
 * Host onboarding by invite (persona tests, S2-5): the shapes the invite page
 * reads from /api/host/invite/*, and the tab-only storage that carries the
 * invite across the Stripe ID check. Pure and DOM-free so it runs under
 * `node --test`. Nothing here tracks anything.
 */

export interface HostTerms {
  version: string;
  sections: Array<{ heading: string; bullets: string[] }>;
}

export interface InvitePeek {
  displayName: string;
  terms: HostTerms;
  consentVersion: string;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function asTerms(v: unknown): HostTerms | null {
  if (!isRec(v) || !isStr(v.version) || !Array.isArray(v.sections) || v.sections.length === 0) return null;
  const sections: HostTerms["sections"] = [];
  for (const s of v.sections) {
    if (!isRec(s) || !isStr(s.heading) || !Array.isArray(s.bullets) || !s.bullets.every(isStr)) return null;
    sections.push({ heading: s.heading, bullets: [...s.bullets] });
  }
  return { version: v.version, sections };
}

export function asInvitePeek(v: unknown): InvitePeek | null {
  if (!isRec(v) || !isStr(v.displayName) || !isStr(v.consentVersion)) return null;
  const terms = asTerms(v.terms);
  return terms ? { displayName: v.displayName, terms, consentVersion: v.consentVersion } : null;
}

/** `?hostinvite=<token>` opens an invite; `?hostinvite=back` is the return from Stripe (no token in it). */
export function hostInviteRoute(search: string): { token: string } | { back: true } | null {
  const v = new URLSearchParams(search).get("hostinvite");
  if (!v) return null;
  return v === "back" ? { back: true } : { token: v };
}

// ---- The invite, kept for this tab (it has to survive the Stripe round trip) ----

export const HOST_INVITE_KEY = "ri_host_invite";

interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function session(): KV | null {
  try {
    return (globalThis as { sessionStorage?: KV }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

export interface StoredInvite { token: string; invitePass: string | null }

export function loadInvite(store: KV | null = session()): StoredInvite | null {
  try {
    const raw = store?.getItem(HOST_INVITE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!isRec(v) || !isStr(v.token)) return null;
    return { token: v.token, invitePass: isStr(v.invitePass) ? v.invitePass : null };
  } catch {
    return null;
  }
}

export function saveInvite(v: StoredInvite | null, store: KV | null = session()): void {
  try {
    if (v) store?.setItem(HOST_INVITE_KEY, JSON.stringify(v));
    else store?.removeItem(HOST_INVITE_KEY);
  } catch { /* private window */ }
}
