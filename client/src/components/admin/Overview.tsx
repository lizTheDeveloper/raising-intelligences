import { useState, useEffect } from "react";
import type { OverviewStats } from "../../hooks/useAdminApi";

interface Props {
  fetchOverview: (token: string) => Promise<OverviewStats>;
  token: string;
}

export function Overview({ fetchOverview, token }: Props) {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchOverview(token)
      .then(setStats)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [fetchOverview, token]);

  if (error) return <div className="loading">Error: {error}</div>;
  if (!stats) return <div className="loading">Loading...</div>;

  const { totalGames, activeGames, completedGames, abandonedGames } = stats;
  const denominator = completedGames + abandonedGames;
  const completionRate =
    denominator > 0 ? Math.round((completedGames / denominator) * 100) : 0;

  return (
    <div className="stat-grid">
      <div className="stat-card">
        <div className="label">Total Games</div>
        <div className="value">{totalGames}</div>
      </div>
      <div className="stat-card">
        <div className="label">Active</div>
        <div className="value">{activeGames}</div>
        <div className="sub">in progress</div>
      </div>
      <div className="stat-card">
        <div className="label">Completed</div>
        <div className="value">{completedGames}</div>
        <div className="sub">{denominator > 0 ? `${completionRate}% completion rate` : "no finished games yet"}</div>
      </div>
      <div className="stat-card">
        <div className="label">Abandoned</div>
        <div className="value">{abandonedGames}</div>
        <div className="sub">7+ days idle</div>
      </div>
      <div className="stat-card deferred">
        <div className="label">LLM Cost</div>
        <div className="value">—</div>
        <div className="sub">cost tracking coming soon</div>
      </div>
    </div>
  );
}
