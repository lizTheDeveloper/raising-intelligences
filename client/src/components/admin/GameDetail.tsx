import { useState, useEffect, useMemo } from "react";
import type { GameDetail, MessageDetail } from "../../hooks/useAdminApi";

interface Props {
  gameId: string;
  fetchGameDetail: (gameId: string) => Promise<GameDetail>;
  onBack: () => void;
}

function formatDuration(createdAt: string, updatedAt: string): string {
  const startMs = new Date(createdAt).getTime();
  const endMs = new Date(updatedAt).getTime();
  const diffMs = endMs - startMs;
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ${diffMinutes % 60}m`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ${diffHours % 24}h`;
}

export function GameDetailView({ gameId, fetchGameDetail, onBack }: Props) {
  const [detail, setDetail] = useState<GameDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    fetchGameDetail(gameId)
      .then(setDetail)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err))
      );
  }, [gameId, fetchGameDetail]);

  if (error) {
    return (
      <div>
        <div style={{ padding: "1rem 1.5rem" }}>
          <button className="back-btn" onClick={onBack}>
            ← Back to games
          </button>
        </div>
        <div className="loading">Error: {error}</div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div>
        <div style={{ padding: "1rem 1.5rem" }}>
          <button className="back-btn" onClick={onBack}>
            ← Back to games
          </button>
        </div>
        <div className="loading">Loading…</div>
      </div>
    );
  }

  const isCompleted = detail.hasEndgame;
  const duration = formatDuration(detail.createdAt, detail.updatedAt);

  const msgCountMap = new Map(
    detail.messageCounts.map((mc) => [mc.eventNumber, mc])
  );

  const messagesByEvent = useMemo(() => {
    const map = new Map<number, MessageDetail[]>();
    for (const msg of detail.messages ?? []) {
      const list = map.get(msg.eventNumber) ?? [];
      list.push(msg);
      map.set(msg.eventNumber, list);
    }
    return map;
  }, [detail.messages]);

  return (
    <div>
      {/* Back button */}
      <div style={{ padding: "1rem 1.5rem" }}>
        <button className="back-btn" onClick={onBack}>
          ← Back to games
        </button>
      </div>

      {/* Status bar */}
      <div className="status-bar">
        <span>
          Phase: <span className="val">{detail.phase}</span>
        </span>
        <span>
          Progress:{" "}
          <span className="val">
            {detail.currentEventNumber}/{detail.totalEvents} events
          </span>
        </span>
        <span>
          Duration: <span className="val">{duration}</span>
        </span>
        <span>
          Relationship:{" "}
          <span className="val">{detail.relationshipType || "—"}</span>
        </span>
        <span>
          Status:{" "}
          <span className="val">{isCompleted ? "Completed" : "In progress"}</span>
        </span>
      </div>

      {/* Players table */}
      {detail.players.length > 0 && (
        <div className="detail-section">
          <h3>Players</h3>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Name</th>
              </tr>
            </thead>
            <tbody>
              {detail.players.map((p) => (
                <tr key={p.slot}>
                  <td>{p.slot}</td>
                  <td>{p.displayName ?? <em style={{ color: "#555" }}>anonymous</em>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Events table */}
      <div className="detail-section">
        <h3>Events</h3>
        <table className="admin-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Age</th>
              <th>Description</th>
              <th>P1 Msgs</th>
              <th>P2 Msgs</th>
              <th>Kid Msgs</th>
            </tr>
          </thead>
          <tbody>
            {detail.events.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ color: "#555", fontStyle: "italic" }}>
                  No events yet
                </td>
              </tr>
            ) : (
              detail.events.map((ev) => {
                const counts = msgCountMap.get(ev.eventNumber);
                return (
                  <tr key={ev.eventNumber}>
                    <td>{ev.eventNumber}</td>
                    <td>{ev.age}</td>
                    <td>{ev.description}</td>
                    <td>{counts?.parent1 ?? 0}</td>
                    <td>{counts?.parent2 ?? 0}</td>
                    <td>{counts?.kid ?? 0}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Sidebar usage */}
      <div className="detail-section">
        <h3>Sidebar Usage</h3>
        <div style={{ color: "#ccc", fontSize: "13px" }}>
          Parent 1:{" "}
          <span style={{ color: detail.sidebarUsed.parent1 ? "#6bcb77" : "#555" }}>
            {detail.sidebarUsed.parent1 ? "Used" : "Not used"}
          </span>
          {" | "}
          Parent 2:{" "}
          <span style={{ color: detail.sidebarUsed.parent2 ? "#6bcb77" : "#555" }}>
            {detail.sidebarUsed.parent2 ? "Used" : "Not used"}
          </span>
        </div>
      </div>

      {/* Identity evolution */}
      {detail.identitySnapshots.length > 0 && (
        <div className="detail-section">
          <h3>Identity Evolution</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {detail.identitySnapshots.map((snap) => (
              <details key={snap.eventNumber}>
                <summary
                  style={{
                    cursor: "pointer",
                    color: "#888",
                    fontSize: "12px",
                    padding: "0.3rem 0",
                    userSelect: "none",
                  }}
                >
                  After Event {snap.eventNumber}
                </summary>
                <div className="identity-diff" style={{ marginTop: "0.5rem" }}>
                  {snap.document}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}

      {/* Current identity document */}
      <div className="detail-section">
        <h3>Current Identity Document</h3>
        <div className="identity-diff">{detail.identityDocument || "—"}</div>
      </div>

      {/* Endgame section */}
      {detail.endgame && (
        <div className="detail-section">
          <h3>Endgame</h3>
          <div style={{ marginBottom: "1rem" }}>
            <div
              style={{
                fontSize: "11px",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "#666",
                marginBottom: "0.5rem",
              }}
            >
              Epilogue
            </div>
            <div className="identity-diff">{detail.endgame.epilogue}</div>
          </div>
          <div>
            <div
              style={{
                fontSize: "11px",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "#666",
                marginBottom: "0.5rem",
              }}
            >
              Report Card
            </div>
            <div className="identity-diff">{detail.endgame.reportCard}</div>
          </div>
        </div>
      )}

      {/* LLM Cost — deferred */}
      <div className="detail-section">
        <h3>LLM Cost</h3>
        <div style={{ color: "#666", fontSize: "13px" }}>
          Cost tracking coming soon
        </div>
      </div>
    </div>
  );
}
