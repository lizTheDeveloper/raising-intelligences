import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response } from "express";

// Mock the @sentry/node SDK so no real client is constructed and no network
// calls are made. Each export is a spy we can assert against.
vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
}));

import * as Sentry from "@sentry/node";
import {
  initSentry,
  isSentryEnabled,
  captureException,
  sentryExpressErrorHandler,
  flushSentry,
  isBenignDisconnect,
  __resetSentryForTests,
} from "../src/observability/sentry.js";

describe("isBenignDisconnect", () => {
  it("drops AbortError (client aborted an SSE/fetch mid-flight)", () => {
    expect(isBenignDisconnect({ name: "AbortError", message: "This operation was aborted" })).toBe(true);
  });
  it("drops mid-write client-disconnect codes", () => {
    expect(isBenignDisconnect({ code: "ECONNRESET" })).toBe(true);
    expect(isBenignDisconnect({ code: "EPIPE" })).toBe(true);
    expect(isBenignDisconnect({ code: "ERR_STREAM_DESTROYED" })).toBe(true);
  });
  it("drops on an 'aborted' message even without a name/code", () => {
    expect(isBenignDisconnect({ message: "Request aborted" })).toBe(true);
  });
  it("KEEPS real server errors", () => {
    expect(isBenignDisconnect({ name: "TypeError", message: "Cannot read properties of undefined" })).toBe(false);
    expect(isBenignDisconnect({ name: "Error", message: "Invalid transition: PARENT_MESSAGE from phase debrief" })).toBe(false);
    expect(isBenignDisconnect({})).toBe(false);
  });
});

const initSpy = vi.mocked(Sentry.init);
const captureSpy = vi.mocked(Sentry.captureException);

describe("Sentry observability layer", () => {
  const originalDsn = process.env.SENTRY_DSN;
  const originalEnv = process.env.SENTRY_ENVIRONMENT;
  const originalRelease = process.env.SENTRY_RELEASE;

  beforeEach(() => {
    __resetSentryForTests();
    initSpy.mockClear();
    captureSpy.mockClear();
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENVIRONMENT;
    delete process.env.SENTRY_RELEASE;
  });

  afterEach(() => {
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    restore("SENTRY_DSN", originalDsn);
    restore("SENTRY_ENVIRONMENT", originalEnv);
    restore("SENTRY_RELEASE", originalRelease);
    __resetSentryForTests();
  });

  describe("without SENTRY_DSN (no-op)", () => {
    it("initSentry reports disabled and never constructs a client", () => {
      expect(initSentry()).toBe(false);
      expect(isSentryEnabled()).toBe(false);
      expect(initSpy).not.toHaveBeenCalled();
    });

    it("captureException is a silent no-op", () => {
      initSentry();
      captureException(new Error("boom"));
      expect(captureSpy).not.toHaveBeenCalled();
    });

    it("flushSentry is a no-op", async () => {
      initSentry();
      await flushSentry();
      expect(vi.mocked(Sentry.flush)).not.toHaveBeenCalled();
    });

    it("the express error handler still forwards the error without capturing", () => {
      initSentry();
      const err = new Error("route failed");
      const next = vi.fn();
      sentryExpressErrorHandler(err, {} as Request, {} as Response, next);
      expect(captureSpy).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(err);
    });
  });

  describe("with SENTRY_DSN set", () => {
    const DSN = "https://pub@errors.multiversegames.ai/6";

    it("initSentry initializes the SDK with the DSN + environment/release", () => {
      process.env.SENTRY_DSN = DSN;
      process.env.SENTRY_ENVIRONMENT = "production";
      process.env.SENTRY_RELEASE = "abc123";

      expect(initSentry()).toBe(true);
      expect(isSentryEnabled()).toBe(true);
      expect(initSpy).toHaveBeenCalledTimes(1);
      expect(initSpy).toHaveBeenCalledWith(
        expect.objectContaining({ dsn: DSN, environment: "production", release: "abc123" })
      );
    });

    it("initSentry is idempotent (second call does not re-init)", () => {
      process.env.SENTRY_DSN = DSN;
      initSentry();
      initSentry();
      expect(initSpy).toHaveBeenCalledTimes(1);
    });

    it("captureException delegates to Sentry with tags", () => {
      process.env.SENTRY_DSN = DSN;
      initSentry();
      const err = new Error("socket blew up");
      captureException(err, { tags: { component: "socket", event: "READY" } });
      expect(captureSpy).toHaveBeenCalledWith(err, {
        tags: { component: "socket", event: "READY" },
      });
    });

    it("the express error handler captures the error and forwards it", () => {
      process.env.SENTRY_DSN = DSN;
      initSentry();
      const err = new Error("route failed");
      const next = vi.fn();
      sentryExpressErrorHandler(err, {} as Request, {} as Response, next);
      expect(captureSpy).toHaveBeenCalledWith(err, { tags: { component: "express" } });
      expect(next).toHaveBeenCalledWith(err);
    });
  });
});
