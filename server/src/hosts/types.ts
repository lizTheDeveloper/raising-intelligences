export type Level = 0 | 1 | 3;
export type EventKind = "studio" | "outside";
export type EventStatus = "open" | "paused" | "closed" | "full" | "not_open_yet";
export type Slot = "parent1" | "parent2";

/**
 * What kind of host a person is (§9.1), set once by the admin. Every event's
 * allowed levels and naming derive from it. See migration 036.
 */
export const HOST_TYPES = ["club", "authority", "events_business", "sensitive", "studio"] as const;
export type HostType = (typeof HOST_TYPES)[number];

export interface HostPerson {
  id: string;
  /** HMAC of the Matrix id, as every stranger record. */
  subject: string;
  displayName: string;
  roleText: string | null;
  roleChecked: string | null;
  roleCheckedAt: number | null;
  agreementVersion: string;
  agreementAt: number;
  status: "approved" | "suspended" | "closed";
  createdAt: number;
  /** null: added before host types; can't go on a new event until set. */
  hostType: HostType | null;
  /** The business or group's name (never shown to players). */
  organisation: string | null;
}

/** The card's computed lines, frozen at the first acknowledgement (H17). */
export interface FrozenTerms {
  cost: "free" | "first_parent";
  /** null: "kept until the studio deletes it". */
  traceRetentionDays: number | null;
  traceWhere: "studio" | "langfuse_cloud";
  handleExchange: boolean;
  learning: boolean;
}

export interface HostEvent {
  id: string;
  codeHash: string;
  source: "admin" | "env";
  name: string;
  kind: EventKind;
  hostPersonId: string | null;
  guestReaderId: string | null;
  /** People who promote this event: refused at the queue and at JOIN_GAME like the host (H12). */
  promoterIds: string[];
  /**
   * How many times this event's code was replaced. The code is derived from
   * the pepper, the id and this count (never stored in the clear), so the
   * host can see it again. Null: a random code from before migration 037,
   * which nobody kept.
   */
  codeSeq: number | null;
  sensitive: boolean;
  authority: boolean;
  eventsBusiness: boolean;
  level: Level;
  shareCodes: boolean;
  studioLearning: boolean;
  handleExchange: boolean;
  welcomeText: string;
  lengthText: string | null;
  conductUrl: string | null;
  capacity: number;
  joinWindowMs: number;
  opensAt: number;
  closesAt: number;
  paused: boolean;
  /** Who paused it: a studio pause is never lifted by the host. */
  pausedBy: "admin" | "host" | null;
  closedAt: number | null;
  cardVersion: number;
  frozenTerms: FrozenTerms | null;
  firstAckAt: number | null;
  publishedFunnel: PublishedFunnel | null;
  publishedAt: number | null;
  createdAt: number;
}

export type Band = "5–9" | "10–19" | "20–49" | "50+";
export type Proportion = "more than half" | "half or fewer" | "not shown at this size";

export type PublishedFunnel =
  | { tooSmall: true }
  | { tooSmall: false; joined: Band; started: Band; finished: Proportion; swapped: Proportion | null };

export interface AckRow {
  id: string;
  eventId: string;
  cardVersion: number;
  preTokenHash: string;
  subject: string | null;
  at: number;
  boundAt: number | null;
  queuedAt: number | null;
  unlistedAt: number | null;
}

export interface ShareDecision {
  gameId: string;
  slot: Slot;
  answer: "yes" | "no" | "later";
  at: number;
  windowEndsAt: number;
}

export interface ShareSnapshot {
  reportCard: string | null;
  epilogue: string | null;
  reportCardOmitted: boolean;
}

export interface ShareCodeRow {
  id: string;
  gameId: string;
  eventId: string;
  codeHash: string;
  snapshot: ShareSnapshot;
  visibleAt: number;
  expiresAt: number;
  redeemedBy: string | null;
  redeemedAt: number | null;
  accessUntil: number | null;
  stoppedAt: number | null;
  stoppedBy: Slot | null;
}

export interface HostReport { id: string; eventId: string | null; text: string; at: number; status: "open" | "done" }
export interface UnlinkRequest { id: string; gameId: string; subject: string; at: number; doneAt: number | null }
