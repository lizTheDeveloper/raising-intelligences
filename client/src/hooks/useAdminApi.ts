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

export interface MessageDetail {
  eventNumber: number;
  sender: string;
  content: string;
  chatType: string;
  timestamp: number;
}

export interface GameDetail extends GameSummary {
  relationshipType: string;
  identityDocument: string;
  events: EventDetail[];
  messageCounts: MessageCounts[];
  messages: MessageDetail[];
  identitySnapshots: { eventNumber: number; document: string }[];
  sidebarUsed: { parent1: boolean; parent2: boolean };
  endgame: { epilogue: string; reportCard: string } | null;
}

export interface ModerationFlag {
  id: string;
  gameId: string;
  childName: string | null;
  sender: string;
  reason: string;
  content: string;
  ipAddress: string | null;
  createdAt: string;
  banned: boolean;
}

async function apiFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new Error("Unauthorized");
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

  function fetchModerationFlags(
    token: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<{ flags: ModerationFlag[]; total: number }> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return apiFetch<{ flags: ModerationFlag[]; total: number }>(
      `/moderation-flags${qs ? `?${qs}` : ""}`,
      token
    );
  }

  function banIp(
    token: string,
    ip: string,
    reason?: string
  ): Promise<{ ok: boolean; ip: string; banned: boolean }> {
    return apiPost("/moderation/ban", token, { ip, reason });
  }

  function unbanIp(token: string, ip: string): Promise<{ ok: boolean; ip: string; banned: boolean }> {
    return apiPost("/moderation/unban", token, { ip });
  }

  return { fetchOverview, fetchGames, fetchGameDetail, fetchModerationFlags, banIp, unbanIp };
}
