import { io, type Socket } from "socket.io-client";
import { SOCKET_EVENTS as E } from "../../src/socket/protocol.js";
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
