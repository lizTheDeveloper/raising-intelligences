export type Level = 0 | 1 | 3;
export type EventKind = "studio" | "outside";
export type EventStatus = "open" | "paused" | "closed" | "full" | "not_open_yet";
export type Slot = "parent1" | "parent2";

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
