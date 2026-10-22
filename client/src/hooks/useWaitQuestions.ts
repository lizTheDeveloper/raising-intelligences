import { useEffect, useRef, useState, useCallback } from "react";
import { track } from "../analytics";
import { createWaitSession, type WaitSession } from "../researchClient";
import type { Question, WaitKind } from "../researchTypes";
import { getGameSecret, getResearchHint } from "./gameSecret";

/**
 * Wait-time questions for one wait. Thin on purpose: the cycle, stale-response
 * and answer logic live in researchClient.ts, where it can be tested without
 * React.
 *
 * The session is created when `active` turns true and disposed when it turns
 * false or the component unmounts, so a card can never outlive its wait and a
 * late response from one cycle cannot land in the next. `sceneIndex` is read
 * once at the start of the cycle (not an effect dependency) — it is the scene
 * the card is shown in, and the answer is posted against that one.
 *
 * Returns `current: null` for every failure and when research is unavailable;
 * callers never need to know why.
 */
export function useWaitQuestions(
  gameId: string | null,
  wait: WaitKind,
  sceneIndex: number,
  active: boolean,
): { current: Question | null; submit: (answer: unknown) => void; skip: () => void } {
  const [current, setCurrent] = useState<Question | null>(null);
  const sessionRef = useRef<WaitSession | null>(null);
  const sceneRef = useRef(sceneIndex);
  sceneRef.current = sceneIndex;

  useEffect(() => {
    // A new cycle never inherits the previous cycle's card.
    setCurrent(null);
    if (!active || !gameId) return;
    const secret = getGameSecret(gameId);
    if (!secret) return;
    // The server said research is off for this game: make no requests at all.
    // No hint (an older game) falls through and asks once.
    const research = getResearchHint(gameId);
    const session = createWaitSession({
      gameId,
      secret,
      wait,
      research,
      sceneIndex: sceneRef.current,
      base: import.meta.env.BASE_URL,
      fetchFn: (input, init) => fetch(input, init),
      now: Date.now,
      onCurrent: setCurrent,
      onEvent: track,
    });
    sessionRef.current = session;
    session.start();
    return () => {
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [gameId, wait, active]);

  const submit = useCallback((answer: unknown) => sessionRef.current?.submit(answer), []);
  const skip = useCallback(() => sessionRef.current?.skip(), []);

  // Gated on `active` as well as state, so the card is gone on the very render
  // the wait ends rather than one effect later.
  return { current: active && gameId ? current : null, submit, skip };
}
