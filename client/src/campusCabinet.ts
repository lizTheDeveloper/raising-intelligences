/**
 * Web cabinets: Raising Intelligences framed inside campus.themultiverse.school.
 * Active only when the page is in a frame AND its URL has `?cabinet=campus`;
 * otherwise this does nothing at all.
 *
 * Handshake (the cabinet contract): post `mg:ready` to the campus origin;
 * campus answers with `mg:pass` (a 5-minute signed launch pass); trade it at
 * POST <base>api/campus-pass for an opaque identity token, keep that in
 * memory (+ sessionStorage for reloads), post `mg:signed-in`, and send it as
 * `campusIdentity` when creating or joining a game. The pass itself is never
 * stored or logged. A cabinet never asks for money (see isCabinetActive).
 */
export const CAMPUS_ORIGIN = "https://campus.themultiverse.school";
export const GAME_KEY = "raising-intelligences";
const STORAGE_KEY = "raising-intelligences:campus-identity:v1";
const REASK_MIN_MS = 60_000;

/**
 * The absolute pass-exchange URL on `origin` itself, or null if it would
 * leave it. `base` is the bundler's configured base (vite `base`, i.e.
 * import.meta.env.BASE_URL) — a build-time constant, never derived from
 * location.pathname: a path like `//evil.example/x` would otherwise become a
 * protocol-relative URL and send the pass to another origin.
 */
export function campusPassUrl(origin: string, base: string): string | null {
  const path = `/${`${base}/api/campus-pass`.replace(/^[/\\]+/, "").replace(/[/\\]{2,}/g, "/")}`;
  try {
    const u = new URL(path, origin);
    return u.origin === origin ? u.href : null;
  } catch {
    return null;
  }
}

export function isCabinetMode(win: Window): boolean {
  let framed: boolean;
  try {
    framed = win.self !== win.top;
  } catch {
    framed = true; // cross-origin top: we are framed
  }
  if (!framed) return false;
  try {
    return new URLSearchParams(win.location.search).get("cabinet") === "campus";
  } catch {
    return false;
  }
}

export interface CabinetDeps {
  win: Window;
  /** import.meta.env.BASE_URL in the app. */
  base: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class CampusCabinet {
  readonly active: boolean;
  identity: string | null = null;
  name: string | null = null;
  private readonly win: Window;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private lastReadyAt = -Infinity;
  private started = false;

  constructor(deps: CabinetDeps) {
    this.win = deps.win;
    this.base = deps.base;
    this.fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.now = deps.now ?? (() => Date.now());
    this.active = isCabinetMode(this.win);
  }

  start(): void {
    if (!this.active || this.started) return;
    this.started = true;
    this.restore();
    this.win.addEventListener("message", (e: MessageEvent) => {
      this.onMessage(e);
    });
    this.postReady();
  }

  /** The server no longer knows our identity: drop it, and ask campus for a fresh pass (≤ once a minute). */
  identityUnknown(): void {
    if (!this.active) return;
    this.identity = null;
    try {
      this.win.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage blocked */
    }
    if (this.now() - this.lastReadyAt >= REASK_MIN_MS) this.postReady();
  }

  private post(type: "mg:ready" | "mg:signed-in"): void {
    try {
      this.win.parent.postMessage({ type, v: 1, game: GAME_KEY }, CAMPUS_ORIGIN);
    } catch {
      /* parent gone */
    }
  }

  private postReady(): void {
    this.lastReadyAt = this.now();
    this.post("mg:ready");
  }

  private onMessage(e: MessageEvent): void {
    if (e.origin !== CAMPUS_ORIGIN || e.source !== this.win.parent) return;
    const d = e.data as { type?: unknown; v?: unknown; pass?: unknown } | null;
    if (!d || typeof d !== "object" || d.type !== "mg:pass" || d.v !== 1 || typeof d.pass !== "string") return;
    void this.exchange(d.pass);
  }

  private async exchange(pass: string): Promise<void> {
    try {
      const url = campusPassUrl(this.win.location.origin, this.base);
      if (!url) return; // never send a pass off this origin
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pass }),
      });
      if (!res.ok) return; // refused: play goes on anonymously
      const body = (await res.json()) as { identity?: unknown; name?: unknown };
      if (typeof body.identity !== "string" || typeof body.name !== "string") return;
      this.identity = body.identity;
      this.name = body.name;
      try {
        this.win.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ identity: body.identity, name: body.name }));
      } catch {
        /* storage blocked */
      }
      this.post("mg:signed-in");
    } catch {
      // network failure: play goes on anonymously
    }
  }

  private restore(): void {
    try {
      const raw = this.win.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const v = JSON.parse(raw) as { identity?: unknown; name?: unknown };
      if (typeof v.identity === "string" && typeof v.name === "string") {
        this.identity = v.identity;
        this.name = v.name;
      }
    } catch {
      /* storage blocked or corrupt */
    }
  }
}

let activeCabinet: CampusCabinet | null = null;
/** The page's cabinet (set once by main.tsx). */
export function setActiveCabinet(c: CampusCabinet | null): void {
  activeCabinet = c;
}
/** True only inside a campus cabinet: hide every real-money ask. */
export function isCabinetActive(): boolean {
  return activeCabinet?.active === true;
}
/** The identity token to send as `campusIdentity`, if signed in through a cabinet. */
export function campusIdentity(): string | undefined {
  return activeCabinet?.active ? activeCabinet.identity ?? undefined : undefined;
}
/** Call when the server answered `campus: "unknown"` to a create or join. */
export function campusIdentityUnknown(): void {
  activeCabinet?.identityUnknown();
}
