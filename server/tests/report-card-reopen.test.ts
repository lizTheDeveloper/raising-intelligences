import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { createGame } from "../src/game/state-machine.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { ViewerState } from "../src/socket/protocol.js";
import type { GameState } from "../src/types.js";
import { TestClient, connect } from "./helpers/socket-client.js";
import { secretHeaders } from "./helpers/game-auth.js";

/**
 * Reopening a finished game shows its report card (persona test B, finding 9).
 *
 * The report card used to reach a client only in the one-shot
 * REPORT_CARD_READY socket event (and, solo, in the SSE reply that generated
 * it). Nothing carried it afterwards: not STATE, not GET /state, not a
 * rehydrated game. So any player who reloaded, closed the tab, or opened the
 * game on another device after the card was written got
 * "No report card was generated." — Dana, showing her own screen in a
 * therapy session, had nothing to show.
 *
 * The fix follows the epilogue's: the report card is server-owned state,
 * rides on every STATE and /state read, and a game rehydrated from the
 * database gets both back from its endgames row.
 */

const REPORT = "# Wren\n## Personality\nWren notices everything and says little.";
const EPILOGUE = "Wren grew up to keep bees on the roof of the library.";

describe("reopening a finished game shows its report card", () => {
  let built: BuiltServer;
  let repo: InMemoryGameRepository;
  let origin: string;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    const mock = new MockLLMClient();
    // The mock answers every completeResponse from this list; the only one in
    // these tests is the report card.
    mock.identityUpdates = [REPORT];
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: mock, repo, enableEviction: false, allowedOrigin: "*", socketPath: "/socket.io" });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await built.close();
  });

  async function client(): Promise<TestClient> {
    const c = await connect(origin);
    clients.push(c);
    return c;
  }

  /** An invite game for two, seated, finished through the real REPORT_CARD handler. */
  async function finishedInviteGame(): Promise<{ gameId: string; tokens: Record<"parent1" | "parent2", string> }> {
    const dana = await client();
    const j1 = dana.once<{ gameId: string; playerToken: string }>(E.JOINED);
    dana.emit(E.CREATE_GAME, { childName: "Wren", displayName: "Dana", relationshipType: "friends" });
    const { gameId, playerToken: t1 } = await j1;
    const fern = await client();
    const j2 = fern.once<{ playerToken: string }>(E.JOINED);
    fern.emit(E.JOIN_GAME, { gameId, displayName: "Fern" });
    const { playerToken: t2 } = await j2;

    // Straight to the epilogue screen: the scenes themselves are covered elsewhere.
    const s = built.games.get(gameId)!;
    built.games.set(gameId, { ...s, phase: "epilogue", epilogue: EPILOGUE });

    const ready = dana.waitFor<{ reportCard: string }>(E.REPORT_CARD_READY);
    dana.emit(E.REPORT_CARD);
    expect((await ready).reportCard).toBe(REPORT);
    return { gameId, tokens: { parent1: t1, parent2: t2 } };
  }

  async function reopen(gameId: string, playerToken: string): Promise<ViewerState> {
    const later = await client();
    const state = later.waitFor<ViewerState>(E.STATE);
    later.emit(E.JOIN_GAME, { gameId, playerToken });
    return state;
  }

  it("a seat that comes back after the card was written gets it on STATE", async () => {
    const { gameId, tokens } = await finishedInviteGame();
    for (const c of clients.splice(0)) c.close();

    const dana = await reopen(gameId, tokens.parent1);
    expect(dana.phase).toBe("report_card");
    expect(dana.reportCard).toBe(REPORT);
    // Same card for the co-parent: it was always broadcast to both seats.
    const fern = await reopen(gameId, tokens.parent2);
    expect(fern.reportCard).toBe(REPORT);
  });

  it("a game rehydrated from the database comes back with its report card and epilogue", async () => {
    const { gameId, tokens } = await finishedInviteGame();
    for (const c of clients.splice(0)) c.close();
    // A restart, an eviction, a second server: only the database is left.
    built.games.delete(gameId);
    built.sessions.delete(gameId);

    const dana = await reopen(gameId, tokens.parent1);
    expect(dana.phase).toBe("report_card");
    expect(dana.reportCard).toBe(REPORT);
    expect(dana.epilogue).toBe(EPILOGUE);
  });

  it("no STATE carries a report card before one exists", async () => {
    const dana = await client();
    const j1 = dana.once<{ gameId: string }>(E.JOINED);
    dana.emit(E.CREATE_GAME, { childName: "Wren", displayName: "Dana", relationshipType: "friends" });
    const { gameId } = await j1;
    const fern = await client();
    const first = fern.waitFor<ViewerState>(E.STATE);
    fern.emit(E.JOIN_GAME, { gameId, displayName: "Fern" });
    expect((await first).reportCard).toBe("");
  });

  it("solo: GET /state on a finished game returns the report card, also after a restart", async () => {
    const game: GameState = { ...createGame("Kai", "solo parent"), phase: "epilogue", epilogue: EPILOGUE };
    built.games.set(game.id, game);
    await repo.saveGame(game);
    const headers = await secretHeaders(repo, game.id);

    const gen = await fetch(`${origin}/api/game/${game.id}/report-card`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({}),
    });
    expect(gen.status).toBe(200);
    await gen.text();

    const read = async () => (await (await fetch(`${origin}/api/game/${game.id}/state`, { headers })).json()) as Record<string, unknown>;
    const live = await read();
    expect(live.phase).toBe("report_card");
    expect(live.reportCard).toBe(REPORT);

    built.games.delete(game.id);
    const rehydrated = await read();
    expect(rehydrated.phase).toBe("report_card");
    expect(rehydrated.reportCard).toBe(REPORT);
    expect(rehydrated.epilogue).toBe(EPILOGUE);
  });
});
