import { useState, useEffect } from "react";
import type { GameSummary } from "../../hooks/useAdminApi";

type StatusFilter = "" | "active" | "completed" | "abandoned";

interface Props {
  fetchGames: (opts?: {
    status?: "active" | "completed" | "abandoned";
    limit?: number;
    offset?: number;
  }) => Promise<{ games: GameSummary[]; total: number }>;
  onSelectGame: (gameId: string) => void;
}

const PAGE_SIZE = 25;

function timeAgo(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function statusLabel(game: GameSummary): string {
  if (game.hasEndgame) return "completed";
  const idleDays = (Date.now() - new Date(game.updatedAt).getTime()) / 86_400_000;
  if (idleDays > 7) return "abandoned";
  return game.phase;
}

export function GameList({ fetchGames, onSelectGame }: Props) {
  const [games, setGames] = useState<GameSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setLoading(true);
    setError(null);
    const opts: Parameters<typeof fetchGames>[0] = {
      limit: PAGE_SIZE,
      offset,
    };
    if (statusFilter !== "") {
      opts.status = statusFilter;
    }
    fetchGames(opts)
      .then(({ games, total }) => {
        setGames(games);
        setTotal(total);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setLoading(false));
  }, [fetchGames, statusFilter, offset]);

  function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setStatusFilter(e.target.value as StatusFilter);
    setOffset(0);
  }

  const filteredGames = search.trim()
    ? games.filter((g) =>
        g.childName.toLowerCase().includes(search.trim().toLowerCase())
      )
    : games;

  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <div>
      <div className="admin-filters">
        <label htmlFor="game-search">Search:</label>
        <input
          id="game-search"
          type="text"
          placeholder="Filter this page…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: "4px",
            color: "#e0e0e0",
            padding: "0.3rem 0.6rem",
            fontSize: "13px",
          }}
        />
        <label htmlFor="game-status">Status:</label>
        <select
          id="game-status"
          value={statusFilter}
          onChange={handleStatusChange}
        >
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="abandoned">Abandoned</option>
        </select>
      </div>

      {error && <div className="loading">Error: {error}</div>}
      {loading && <div className="loading">Loading…</div>}

      {!loading && !error && (
        <table className="admin-table" style={{ margin: "1rem 0" }}>
          <thead>
            <tr>
              <th>Child</th>
              <th>Players</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Last Activity</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {filteredGames.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ color: "#555", fontStyle: "italic" }}>
                  No games found
                </td>
              </tr>
            ) : (
              filteredGames.map((game) => (
                <tr key={game.id}>
                  <td>
                    <button
                      onClick={() => onSelectGame(game.id)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "#4a9eff",
                        cursor: "pointer",
                        fontSize: "13px",
                        padding: 0,
                        textDecoration: "underline",
                      }}
                    >
                      {game.childName}
                    </button>
                  </td>
                  <td>
                    {game.players
                      .map((p) => p.displayName ?? p.slot)
                      .join(", ")}
                  </td>
                  <td>{statusLabel(game)}</td>
                  <td>
                    {game.currentEventNumber}/{game.totalEvents}
                  </td>
                  <td>{timeAgo(game.updatedAt)}</td>
                  <td>{new Date(game.createdAt).toLocaleDateString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      <div className="pagination">
        <button disabled={!hasPrev} onClick={() => setOffset(offset - PAGE_SIZE)}>
          Prev
        </button>
        <span>
          {total === 0
            ? "0 games"
            : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
        </span>
        <button disabled={!hasNext} onClick={() => setOffset(offset + PAGE_SIZE)}>
          Next
        </button>
      </div>
    </div>
  );
}
