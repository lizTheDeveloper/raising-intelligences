import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestServer, type TestServer } from "./helpers/test-server.js";

const UPSTREAM_URL = "https://multiversestudios.xyz/stripe/create-checkout-session";

describe("Support checkout route", () => {
  let server: TestServer;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    server = await createTestServer("support-routes");
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Stubs only the upstream stripe-webhook call; requests to our own test
   * server (the assertions in each test) still hit the real fetch, so the
   * mock can't accidentally swallow the test's own HTTP call.
   */
  function mockUpstream(handler: (init: RequestInit) => Response) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === UPSTREAM_URL) return handler(init ?? {});
      return realFetch(input, init);
    });
  }

  it("proxies a valid amount to the upstream checkout endpoint and returns its url", async () => {
    const fetchSpy = mockUpstream(
      () => new Response(JSON.stringify({ url: "https://checkout.stripe.com/pay/cs_test_123" }), { status: 200 })
    );

    const res = await fetch(`${server.baseUrl}/api/support/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 500, sourcePage: "epilogue" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ url: "https://checkout.stripe.com/pay/cs_test_123" });

    const upstreamCall = fetchSpy.mock.calls.find(([input]) => input === UPSTREAM_URL);
    expect(upstreamCall).toBeDefined();
    const body = JSON.parse((upstreamCall![1] as RequestInit).body as string);
    expect(body).toEqual({ game: "raising_intelligences", amount: 500, source_page: "epilogue" });
  });

  it.each([-1, 0, 50, 100_001, 1.5])("rejects an invalid amount (%s) with 400", async (amount) => {
    const res = await fetch(`${server.baseUrl}/api/support/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 502 when the upstream checkout service errors", async () => {
    mockUpstream(
      () => new Response(JSON.stringify({ error: "game must be one of: precursors, mvee" }), { status: 400 })
    );

    const res = await fetch(`${server.baseUrl}/api/support/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 300 }),
    });

    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toBe("Could not start checkout");
  });

  it("returns 502 when the upstream response has no url", async () => {
    mockUpstream(() => new Response(JSON.stringify({}), { status: 200 }));

    const res = await fetch(`${server.baseUrl}/api/support/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 300 }),
    });

    expect(res.status).toBe(502);
  });

  it("returns 500 when the upstream call throws", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === UPSTREAM_URL) throw new Error("network down");
      return realFetch(input, init);
    });

    const res = await fetch(`${server.baseUrl}/api/support/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 300 }),
    });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("An internal error occurred");
  });
});
