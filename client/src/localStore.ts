/**
 * The game's localStorage bookkeeping: the saved-kids list and the
 * multiplayer resume credential. Plain functions, testable without React.
 *
 * Every access is guarded: storage can be missing or throw (private windows,
 * blocked site data, and a campus web cabinet, which is a cross-site iframe
 * where third-party storage is often blocked). A failed write only means the
 * list or the resume isn't remembered; it never stops the game.
 */

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: not remembered, game goes on */
  }
}

export interface SavedKid {
  gameId: string;
  childName: string;
  createdAt: number;
}

const KIDS_KEY = "raising-intelligences-kids";
const RESUME_KEY = "ri_resume";

export function getSavedKids(): SavedKid[] {
  try {
    return JSON.parse(localStorage.getItem(KIDS_KEY) || "[]");
  } catch {
    return [];
  }
}

export function saveKid(gameId: string, childName: string) {
  const kids = getSavedKids().filter((k) => k.gameId !== gameId);
  kids.unshift({ gameId, childName, createdAt: Date.now() });
  write(KIDS_KEY, JSON.stringify(kids));
}

export function mergeKids(local: SavedKid[], remote: SavedKid[]): SavedKid[] {
  const map = new Map<string, SavedKid>();
  for (const k of [...remote, ...local]) map.set(k.gameId, k);
  const merged = [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
  write(KIDS_KEY, JSON.stringify(merged));
  return merged;
}

export interface ResumeData {
  gameId: string;
  playerToken: string;
}

export function loadResume(): ResumeData | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.gameId && data?.playerToken) return data as ResumeData;
    return null;
  } catch {
    return null;
  }
}

export function saveResume(gameId: string, playerToken: string): void {
  write(RESUME_KEY, JSON.stringify({ gameId, playerToken }));
}

export function clearResume(): void {
  try {
    localStorage.removeItem(RESUME_KEY);
  } catch {
    /* storage blocked: nothing was stored */
  }
}
