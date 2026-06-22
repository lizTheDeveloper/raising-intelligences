import type { Sender } from "../types.js";

/**
 * Multiplayer session bookkeeping — kept pure and free of socket.io so it can
 * be unit-tested. A Session tracks which connections occupy the two parent
 * slots, their display names, and their ready state. The authoritative game
 * state lives elsewhere (the games Map); a Session only models "who is in this
 * room and are they ready."
 */

export type PlayerSlot = "parent1" | "parent2";

export interface Player {
  slot: PlayerSlot;
  connectionId: string;
  displayName: string;
  ready: boolean;
}

export interface Session {
  gameId: string;
  players: Player[];
}

export function createSession(gameId: string): Session {
  return { gameId, players: [] };
}

/** The two parent slots, in assignment order. */
const SLOTS: PlayerSlot[] = ["parent1", "parent2"];

export function isFull(session: Session): boolean {
  return session.players.length >= SLOTS.length;
}

export function getPlayer(session: Session, connectionId: string): Player | undefined {
  return session.players.find((p) => p.connectionId === connectionId);
}

export function getPlayerBySlot(session: Session, slot: PlayerSlot): Player | undefined {
  return session.players.find((p) => p.slot === slot);
}

/**
 * Add a connection to the first free parent slot. If the connection is already
 * present, it is returned unchanged (idempotent reconnects). Throws when the
 * room is full and the connection is new — knowing the link is not enough to
 * exceed two players.
 */
export function addPlayer(
  session: Session,
  connectionId: string,
  displayName?: string
): { session: Session; player: Player } {
  const existing = getPlayer(session, connectionId);
  if (existing) return { session, player: existing };

  const takenSlots = new Set(session.players.map((p) => p.slot));
  const slot = SLOTS.find((s) => !takenSlots.has(s));
  if (!slot) {
    throw new Error("Session is full (two players maximum)");
  }

  const player: Player = {
    slot,
    connectionId,
    displayName: displayName?.trim() || defaultName(slot),
    ready: false,
  };
  const next: Session = { ...session, players: [...session.players, player] };
  return { session: next, player };
}

export function removePlayer(session: Session, connectionId: string): Session {
  return {
    ...session,
    players: session.players.filter((p) => p.connectionId !== connectionId),
  };
}

export function setReady(
  session: Session,
  connectionId: string,
  ready: boolean
): Session {
  return {
    ...session,
    players: session.players.map((p) =>
      p.connectionId === connectionId ? { ...p, ready } : p
    ),
  };
}

export function setDisplayName(
  session: Session,
  connectionId: string,
  displayName: string
): Session {
  const trimmed = displayName.trim();
  return {
    ...session,
    players: session.players.map((p) =>
      p.connectionId === connectionId && trimmed ? { ...p, displayName: trimmed } : p
    ),
  };
}

/** Both slots filled and both players ready — the start/proceed gate. */
export function allReady(session: Session): boolean {
  return (
    session.players.length === SLOTS.length &&
    session.players.every((p) => p.ready)
  );
}

/** Clear ready flags — used between phases so both must re-confirm. */
export function resetReady(session: Session): Session {
  return {
    ...session,
    players: session.players.map((p) => ({ ...p, ready: false })),
  };
}

export function slotToSender(slot: PlayerSlot): Sender {
  return slot;
}

function defaultName(slot: PlayerSlot): string {
  return slot === "parent1" ? "Parent 1" : "Parent 2";
}
