import { useState } from "react";
import type { PublicPlayer, Slot } from "../hooks/useMultiplayer";

interface Props {
  gameId: string;
  slot: Slot | null;
  players: PublicPlayer[];
  childName: string;
  error: string | null;
  onReady: (ready: boolean) => void;
  onLeave: () => void;
}

export function Lobby({ gameId, slot, players, childName, error, onReady, onLeave }: Props) {
  const [ready, setReady] = useState(false);
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const link = `${window.location.origin}${base}/?game=${gameId}`;
  const me = players.find((p) => p.slot === slot);
  const both = players.length === 2;
  const bothConnected = both && players.every((p) => p.connected);
  const coParentDisconnected = both && players.some((p) => !p.connected);

  const toggle = () => {
    const next = !ready;
    setReady(next);
    onReady(next);
  };

  const copy = () => {
    navigator.clipboard?.writeText(link).catch(() => {});
  };

  return (
    <div className="lobby">
      <h1>raising {childName || "intelligences"}</h1>
      <p className="dim">you are {me?.displayName ?? slot}</p>

      <div className="lobby-players">
        {(["parent1", "parent2"] as Slot[]).map((s) => {
          const p = players.find((pl) => pl.slot === s);
          return (
            <div key={s} className="lobby-player">
              <span className="lobby-player-name">{p?.displayName ?? "waiting…"}</span>
              <span className="lobby-player-status dim">
                {!p ? "—" : !p.connected ? "disconnected" : p.ready ? "ready" : "not ready"}
              </span>
            </div>
          );
        })}
      </div>

      {(!both || coParentDisconnected) && (
        <div className="lobby-invite">
          <p className="dim">
            {coParentDisconnected
              ? "your co-parent disconnected — send them the link to rejoin"
              : "send this link to your co-parent"}
          </p>
          <button className="btn btn-secondary" onClick={copy}>
            copy invite link
          </button>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      <button className="btn" onClick={toggle} disabled={!bothConnected}>
        {ready ? "waiting for the other parent…" : bothConnected ? "ready" : "waiting for player 2…"}
      </button>

      <button className="btn btn-secondary" onClick={onLeave} style={{ marginTop: 12 }}>
        leave game
      </button>
    </div>
  );
}
