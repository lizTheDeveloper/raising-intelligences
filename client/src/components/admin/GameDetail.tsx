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

      {/* Events + Conversations */}
      <div className="detail-section">
        <h3>Events</h3>
        {detail.events.length === 0 ? (
          <div style={{ color: "#555", fontStyle: "italic" }}>No events yet</div>
        ) : (
          detail.events.map((ev) => {
            const counts = msgCountMap.get(ev.eventNumber);
            const msgs = messagesByEvent.get(ev.eventNumber) ?? [];
            const totalMsgs = (counts?.parent1 ?? 0) + (counts?.parent2 ?? 0) + (counts?.kid ?? 0);
            return (
              <details key={ev.eventNumber} style={{ marginBottom: "0.5rem" }}>
                <summary
                  style={{
                    cursor: "pointer",
                    padding: "0.5rem 0",
                    userSelect: "none",
                    color: "#ccc",
                    fontSize: "13px",
                  }}
                >
                  <strong>#{ev.eventNumber}</strong> Age {ev.age} — {ev.description}
                  <span style={{ color: "#666", marginLeft: "0.75rem" }}>
                    {totalMsgs} messages
                    {counts?.parent2 ? ` (P1: ${counts.parent1}, P2: ${counts.parent2}, Kid: ${counts.kid})` : ` (Parent: ${counts?.parent1 ?? 0}, Kid: ${counts?.kid ?? 0})`}
                  </span>
                </summary>
                <div style={{ padding: "0.5rem 0 0.5rem 1.5rem" }}>
                  {msgs.length === 0 ? (
                    <div style={{ color: "#555", fontStyle: "italic", fontSize: "12px" }}>
                      No messages recorded
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                      {msgs.map((msg, i) => {
                        const isKid = msg.sender === "kid";
                        const isSidebar = msg.chatType === "private";
                        return (
                          <div
                            key={i}
                            style={{
                              padding: "0.4rem 0.6rem",
                              borderRadius: "6px",
                              fontSize: "13px",
                              lineHeight: "1.4",
                              backgroundColor: isKid ? "#1a2a1a" : "#1a1a2a",
                              borderLeft: `3px solid ${isKid ? "#6bcb77" : "#4d96ff"}`,
                            }}
                          >
                            <div style={{ fontSize: "11px", color: "#888", marginBottom: "0.2rem" }}>
                              {msg.sender === "kid" ? "Kid" : msg.sender === "parent1" ? "Parent 1" : "Parent 2"}
                              {isSidebar && (
                                <span style={{ color: "#c77dff", marginLeft: "0.5rem" }}>
                                  (sidebar)
                                </span>
                              )}
                            </div>
                            <div style={{ color: "#ddd", whiteSpace: "pre-wrap" }}>{msg.content}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </details>
            );
          })
        )}
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

      {/* LLM Traces */}
      <div className="detail-section">
        <h3>LLM Traces</h3>
        <div style={{ fontSize: "13px" }}>
          <a
            href={`https://langfuse.multiversegames.ai/traces?filter=tags%3Agame_id%3A${detail.id}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#4d96ff" }}
          >
            View traces in Langfuse
          </a>
        </div>
      </div>
    </div>
  );
}
