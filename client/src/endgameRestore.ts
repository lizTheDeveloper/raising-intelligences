/**
 * The endgame text a reopened game carries (GET /state, or a socket STATE).
 *
 * The epilogue and report card used to reach a client only in the one-shot
 * event (or SSE reply) that generated them, so a reload or a second device
 * showed "No report card was generated." The server now sends both with the
 * game's state. Only non-empty strings are taken: every state before they
 * exist carries "", and a server that predates the fields sends nothing,
 * and neither may clobber text that arrived first.
 */
export function restoredEndgame(data: unknown): { epilogue?: string; reportCard?: string } {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const out: { epilogue?: string; reportCard?: string } = {};
  if (typeof d.epilogue === "string" && d.epilogue !== "") out.epilogue = d.epilogue;
  if (typeof d.reportCard === "string" && d.reportCard !== "") out.reportCard = d.reportCard;
  return out;
}
