import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response } from "express";

// Mock the @sentry/node SDK so no real client is constructed and no network
// calls are made. Each export is a spy we can assert against.
vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  httpIntegration: vi.fn((o: unknown) => ({ name: "Http", opts: o })),
}));

import * as Sentry from "@sentry/node";
import {
  initSentry,
  isSentryEnabled,
  captureException,
  sentryExpressErrorHandler,
  flushSentry,
  isBenignDisconnect,
  scrubResearchEvent,
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

describe("scrubResearchEvent", () => {
  const ev = (url: string) => ({
    request: { url, data: { answer: "SECRET-TEXT" }, cookies: { a: "b" }, query_string: "x=SECRET", headers: { "x-game-secret": "S" } },
    exception: { values: [{ type: "SyntaxError", value: "Unexpected token SECRET-TEXT in JSON" }] },
    message: "failed SECRET-TEXT",
  }) as never as Parameters<typeof scrubResearchEvent>[0];
  for (const url of [
    "https://x.test/api/game/6a66aab-1/answers",
    "https://x.test/api/game/6a66aab-1/repair",
    "https://x.test/api/research/followup/6a66aab-1",
    "https://x.test/api/game/6a66aab-1/answers?x=1",
  ]) {
    it(`drops body, cookies, query, headers and message text for ${url}`, () => {
      const out = scrubResearchEvent(ev(url));
      expect(JSON.stringify(out)).not.toContain("SECRET");
      expect(out.request?.data).toBeUndefined();
      expect(out.request?.cookies).toBeUndefined();
      expect(out.request?.query_string).toBeUndefined();
      expect(out.exception?.values?.[0].value).toMatch(/redacted/);
    });
  }
  it("leaves a non-research URL intact", () => {
    for (const url of ["https://x.test/api/game/abc/message", "https://x.test/api/game/abc/answers-export", "https://x.test/api/game"]) {
      const out = scrubResearchEvent(ev(url));
      expect(out.request?.data).toEqual({ answer: "SECRET-TEXT" });
      expect(out.exception?.values?.[0].value).toContain("SECRET-TEXT");
    }
  });
  it("init disables incoming request body capture and wires beforeSend through the scrub", () => {
    const orig = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://k@example.test/1";
    __resetSentryForTests();
    initSentry();
    const opts = vi.mocked(Sentry.init).mock.calls.at(-1)![0] as { integrations: Array<{ opts: unknown }>; beforeSend: (e: unknown, h: unknown) => unknown };
    expect(opts.integrations[0].opts).toEqual({ maxIncomingRequestBodySize: "none" });
    const out = opts.beforeSend(ev("https://x.test/api/game/g/repair"), {}) as { request: { data?: unknown } };
    expect(out.request.data).toBeUndefined();
    if (orig === undefined) delete process.env.SENTRY_DSN; else process.env.SENTRY_DSN = orig;
    __resetSentryForTests();
  });
});

describe("initSentry beforeSend scrubs every route, not just research routes", () => {
  it("drops Authorization / x-game-secret / cookies / body / query on a non-research URL", () => {
    const orig = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://k@example.test/1";
    __resetSentryForTests();
    initSentry();
    const opts = vi.mocked(Sentry.init).mock.calls.at(-1)![0] as { beforeSend: (e: unknown, h: unknown) => unknown };
    const event = {
      request: {
        url: "https://x.test/api/child-safety/cases?token=SECRET-Q",
        query_string: "token=SECRET-Q",
        data: '{"note":"SECRET-BODY"}',
        cookies: { s: "SECRET-COOKIE" },
        headers: { authorization: "Bearer SECRET-ADMIN", "x-game-secret": "SECRET-GAME", "user-agent": "ua" },
      },
      exception: { values: [{ type: "TypeError", value: "x is undefined" }] },
    };
    const out = opts.beforeSend(event, {}) as typeof event;
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(out.request.headers).toEqual({ "user-agent": "ua" });
    // A non-research error keeps its message (still debuggable).
    expect(out.exception.values[0].value).toBe("x is undefined");
    if (orig === undefined) delete process.env.SENTRY_DSN; else process.env.SENTRY_DSN = orig;
    __resetSentryForTests();
  });
});

describe("initSentry wires beforeBreadcrumb through the breadcrumb scrub", () => {
  it("strips http.query from an outgoing-http crumb and the query from beforeSend breadcrumbs", () => {
    const orig = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://k@example.test/1";
    __resetSentryForTests();
    initSentry();
    const opts = vi.mocked(Sentry.init).mock.calls.at(-1)![0] as {
      beforeBreadcrumb: (b: unknown) => unknown;
      beforeSend: (e: unknown, h: unknown) => unknown;
    };
    const crumb = opts.beforeBreadcrumb({ category: "http", data: { url: "https://api.test/x", "http.query": "?token=SECRET-Q" } });
    expect(JSON.stringify(crumb)).not.toContain("SECRET");
    const out = opts.beforeSend({ breadcrumbs: [{ category: "navigation", data: { from: "/x#handoff=SECRET-H", to: "/x" } }] }, {});
    expect(JSON.stringify(out)).not.toContain("SECRET");
    if (orig === undefined) delete process.env.SENTRY_DSN; else process.env.SENTRY_DSN = orig;
    __resetSentryForTests();
  });
});
