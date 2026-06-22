import { useState } from "react";
import type { PublicPlayer, Slot } from "../hooks/useMultiplayer";

interface Props {
  gameId: string;
  slot: Slot | null;
  players: PublicPlayer[];
  childName: string;
  onReady: (ready: boolean) => void;
}

/**
 * Shared waiting room. Shows the invite link, both players' presence/ready
 * state, and a ready toggle. Knowing the link is being a player — the second
 * person just opens it.
 */
export function Lobby({ gameId, slot, players, childName, onReady }: Props) {
  const [ready, setReady] = useState(false);
  const link = `${window.location.origin}/?game=${gameId}`;
  const me = players.find((p) => p.slot === slot);
  const both = players.length === 2;

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
                {!p ? "—" : p.ready ? "ready" : "not ready"}
              </span>
            </div>
          );
        })}
      </div>

      {!both && (
        <div className="lobby-invite">
          <p className="dim">send this link to your co-parent</p>
          <button className="btn btn-secondary" onClick={copy}>
            copy invite link
          </button>
        </div>
      )}

      <button className="btn" onClick={toggle} disabled={!both}>
        {ready ? "waiting for the other parent…" : both ? "ready" : "waiting for player 2…"}
      </button>
    </div>
  );
}
