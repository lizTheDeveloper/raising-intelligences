const BASE = import.meta.env.BASE_URL + "api/admin";

export interface OverviewStats {
  totalGames: number;
  activeGames: number;
  completedGames: number;
  abandonedGames: number;
}

export interface GameSummary {
  id: string;
  childName: string;
  phase: string;
  currentEventNumber: number;
  totalEvents: number;
  createdAt: string;
  updatedAt: string;
  hasEndgame: boolean;
  players: { slot: string; displayName: string | null }[];
}

export interface EventDetail {
  eventNumber: number;
  age: number;
  description: string;
  setting: string;
  trigger: string;
  createdAt: string;
}

export interface MessageCounts {
  eventNumber: number;
  parent1: number;
  parent2: number;
  kid: number;
}

export interface GameDetail extends GameSummary {
  relationshipType: string;
  identityDocument: string;
  events: EventDetail[];
  messageCounts: MessageCounts[];
  identitySnapshots: { eventNumber: number; document: string }[];
  sidebarUsed: { parent1: boolean; parent2: boolean };
  endgame: { epilogue: string; reportCard: string } | null;
}

async function apiFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new Error("Unauthorized");
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export function useAdminApi() {
  function fetchOverview(token: string): Promise<OverviewStats> {
    return apiFetch<OverviewStats>("/overview", token);
  }

  function fetchGames(
    token: string,
    opts?: { status?: "active" | "completed" | "abandoned"; limit?: number; offset?: number }
  ): Promise<{ games: GameSummary[]; total: number }> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return apiFetch<{ games: GameSummary[]; total: number }>(`/games${qs ? `?${qs}` : ""}`, token);
  }

  function fetchGameDetail(token: string, gameId: string): Promise<GameDetail> {
    return apiFetch<GameDetail>(`/games/${gameId}`, token);
  }

  return { fetchOverview, fetchGames, fetchGameDetail };
}
