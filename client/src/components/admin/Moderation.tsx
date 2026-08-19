import { useState, useEffect, useCallback } from "react";
import type { ModerationFlag } from "../../hooks/useAdminApi";

interface Props {
  fetchModerationFlags: (opts?: {
    limit?: number;
    offset?: number;
  }) => Promise<{ flags: ModerationFlag[]; total: number }>;
  banIp: (ip: string, reason?: string) => Promise<{ banned: boolean }>;
  unbanIp: (ip: string) => Promise<{ banned: boolean }>;
}

const PAGE_SIZE = 50;

function timeAgo(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function Moderation({ fetchModerationFlags, banIp, unbanIp }: Props) {
  const [flags, setFlags] = useState<ModerationFlag[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyIp, setBusyIp] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchModerationFlags({ limit: PAGE_SIZE, offset })
      .then(({ flags, total }) => {
        setFlags(flags);
        setTotal(total);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [fetchModerationFlags, offset]);

  useEffect(() => {
    load();
  }, [load]);

  // Reflect a ban/unban across every row that shares the IP.
  function applyBanState(ip: string, banned: boolean) {
    setFlags((prev) => prev.map((f) => (f.ipAddress === ip ? { ...f, banned } : f)));
  }

  async function handleBan(ip: string, childName: string | null) {
    if (busyIp) return;
    if (!window.confirm(`Ban ${ip}? This blocks all new games from that address.`)) return;
    setBusyIp(ip);
    try {
      await banIp(ip, `admin review: flagged session${childName ? ` (${childName})` : ""}`);
      applyBanState(ip, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyIp(null);
    }
  }

  async function handleUnban(ip: string) {
    if (busyIp) return;
    setBusyIp(ip);
    try {
      await unbanIp(ip);
      applyBanState(ip, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyIp(null);
    }
  }

  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <div>
      <p style={{ color: "#888", fontSize: "13px", margin: "0.5rem 0 1rem" }}>
        Sessions flagged by the safety checks. A first scene-level flag ends the session; a repeat
        flag from the same address auto-bans it. Review and ban/unban manually here.
      </p>

      {error && <div className="loading">Error: {error}</div>}
      {loading && <div className="loading">Loading…</div>}

      {!loading && !error && (
        <table className="admin-table" style={{ margin: "1rem 0" }}>
          <thead>
            <tr>
              <th>Flagged</th>
              <th>Child</th>
              <th>Sender</th>
              <th>Reason</th>
              <th>IP</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {flags.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ color: "#555", fontStyle: "italic" }}>
                  No flagged sessions
                </td>
              </tr>
            ) : (
              flags.map((f) => (
                <tr key={f.id} style={f.banned ? { opacity: 0.6 } : undefined}>
                  <td title={new Date(f.createdAt).toLocaleString()}>{timeAgo(f.createdAt)}</td>
                  <td>{f.childName ?? "—"}</td>
                  <td>{f.sender}</td>
                  <td style={{ maxWidth: 360 }}>
                    <button
                      onClick={() => setExpanded(expanded === f.id ? null : f.id)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "#e0e0e0",
                        cursor: "pointer",
                        fontSize: "13px",
                        padding: 0,
                        textAlign: "left",
                      }}
                    >
                      {expanded === f.id ? f.reason : `${f.reason.slice(0, 90)}${f.reason.length > 90 ? "…" : ""}`}
                    </button>
                  </td>
                  <td style={{ fontFamily: "monospace", fontSize: "12px" }}>
                    {f.ipAddress ?? "—"}
                    {f.banned && (
                      <span style={{ color: "#ff6b6b", marginLeft: 6, fontFamily: "sans-serif" }}>
                        banned
                      </span>
                    )}
                  </td>
                  <td>
                    {!f.ipAddress ? (
                      <span style={{ color: "#555" }}>no ip</span>
                    ) : f.banned ? (
                      <button
                        disabled={busyIp === f.ipAddress}
                        onClick={() => handleUnban(f.ipAddress as string)}
                      >
                        Unban
                      </button>
                    ) : (
                      <button
                        disabled={busyIp === f.ipAddress}
                        onClick={() => handleBan(f.ipAddress as string, f.childName)}
                        style={{ color: "#ff6b6b" }}
                      >
                        Ban IP
                      </button>
                    )}
                  </td>
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
            ? "0 flags"
            : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
        </span>
        <button disabled={!hasNext} onClick={() => setOffset(offset + PAGE_SIZE)}>
          Next
        </button>
      </div>
    </div>
  );
}
