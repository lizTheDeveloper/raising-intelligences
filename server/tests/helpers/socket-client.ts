import { io, type Socket } from "socket.io-client";
import { SOCKET_EVENTS as E, SOCKET_EVENTS } from "../../src/socket/protocol.js";
import type { LobbyState, ViewerState } from "../../src/socket/protocol.js";

/**
 * Recording makes live LLM calls behind a socket round-trip — some qwen
 * generations run well over 15s — so allow long waits when recording. In
 * replay everything resolves in milliseconds, so a short ceiling is plenty and
 * surfaces real hangs quickly.
 */
const RECORDING = process.env.LLM_CACHE_MODE === "record" || process.env.LLM_CACHE_MODE === "auto";
const DEFAULT_TIMEOUT_MS = RECORDING ? 180_000 : 20_000;

/**
 * Thin promise-friendly wrapper around a socket.io client for tests. It keeps
 * the latest lobby/state snapshots, accumulates streamed kid chunks, and lets a
 * test `await` the next occurrence of any event. Nothing here mocks the server
 * — it is a real socket.io connection to the in-process server.
 */
export class TestClient {
  readonly socket: Socket;
  lastLobby?: LobbyState;
  lastState?: ViewerState;
  lastError?: string;
  /** Text accumulated from KID_CHUNK since the last reset. */
  kidStream = "";
  private stateLog: ViewerState[] = [];

  constructor(baseUrl: string) {
    this.socket = io(baseUrl, { transports: ["websocket"], forceNew: true });
    this.socket.on(E.LOBBY, (l: LobbyState) => (this.lastLobby = l));
    this.socket.on(E.STATE, (s: ViewerState) => {
      this.lastState = s;
      this.stateLog.push(s);
    });
    this.socket.on(E.KID_CHUNK, (c: { text: string }) => (this.kidStream += c.text));
    this.socket.on(E.ERROR, (e: { error: string }) => (this.lastError = e.error));
  }

  async connected(): Promise<this> {
    if (this.socket.connected) return this;
    await this.once("connect");
    return this;
  }

  /**
   * Resolve with the next payload for `event` that satisfies `predicate`,
   * ignoring earlier non-matching ones. Use this (registered *before* emitting
   * the trigger) to avoid races where the awaited event arrives before a plain
   * `once` listener is attached.
   */
  waitFor<T = unknown>(
    event: string,
    predicate: (payload: T) => boolean = () => true,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off(event, handler);
        reject(new Error(`Timed out waiting for "${event}" after ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = (payload: T) => {
        if (!predicate(payload)) return;
        clearTimeout(timer);
        this.socket.off(event, handler);
        resolve(payload);
      };
      this.socket.on(event, handler);
    });
  }

  /** Resolve with the next payload for `event`, or reject after `timeoutMs`. */
  once<T = unknown>(event: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off(event, handler);
        reject(new Error(`Timed out waiting for "${event}" after ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      };
      this.socket.once(event, handler);
    });
  }

  emit(event: string, payload?: unknown): void {
    this.socket.emit(event, payload);
  }

  resetStream(): void {
    this.kidStream = "";
  }

  states(): ViewerState[] {
    return this.stateLog;
  }

  close(): void {
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}

export async function connect(baseUrl: string): Promise<TestClient> {
  const client = new TestClient(baseUrl);
  await client.connected();
  return client;
}

/**
 * A valid OCEAN answer set, one per parent, for tests that just need the
 * opening handshake to complete. Values must be integers 1-4 or
 * SUBMIT_PERSONALITY rejects them.
 */
export const OCEAN_P1: [number, number, number, number, number] = [3, 2, 4, 2, 3];
export const OCEAN_P2: [number, number, number, number, number] = [2, 4, 1, 3, 2];

/**
 * Complete the opening: both parents ready out of the lobby, then both submit
 * their personality.
 *
 * Since the 2026-07-31 reorder the lobby gate generates nothing — readying only
 * takes a player into the guardian quiz. Scene 1 is built when the personality
 * seed lands, so that the world manager sees the seed and both parents instead
 * of an empty one. Every multiplayer test that wants a playable scene has to go
 * through the quiz now, which is what this does.
 *
 * `submitOnly` skips the READY emits for tests that assert on the ready flags
 * themselves.
 */
export function submitPersonalities(
  p1: TestClient,
  p2: TestClient,
  opts: { ready?: boolean } = {}
): void {
  if (opts.ready !== false) {
    p1.emit(SOCKET_EVENTS.READY, { ready: true });
    p2.emit(SOCKET_EVENTS.READY, { ready: true });
  }
  p1.emit(SOCKET_EVENTS.SUBMIT_PERSONALITY, {
    ocean: OCEAN_P1,
    confessional1: "I told my sister her hamster ran away.",
    confessional2: "I failed a class and forged the report card.",
  });
  p2.emit(SOCKET_EVENTS.SUBMIT_PERSONALITY, {
    ocean: OCEAN_P2,
    confessional1: "I broke a window and blamed the neighbour's kid.",
    confessional2: "I never told them I got expelled from chess club.",
  });
}

/**
 * Drive the whole opening and resolve on the STATE that carries scene 1.
 * Register nothing before calling — the waiter is attached first internally.
 */
export function openFirstScene(
  p1: TestClient,
  p2: TestClient,
  opts: { ready?: boolean } = {}
): Promise<ViewerState> {
  const scene = p1.waitFor<ViewerState>(
    SOCKET_EVENTS.STATE,
    (s) => s.phase === "family_chat" && s.currentEvent != null
  );
  submitPersonalities(p1, p2, opts);
  return scene;
}
