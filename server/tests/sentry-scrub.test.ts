import { describe, it, expect } from "vitest";
import { stripRequestBody, stripQuery, scrubBreadcrumb, scrubEvent } from "../src/observability/sentry-scrub.js";

const leaky = () => ({
  request: {
    url: "https://multiversegames.ai/raising-intelligences/api/admin/games?token=s3cret#handoff=HC",
    query_string: "token=s3cret",
    data: '{"childName":"Ada","relationshipType":"solo parent"}',
    cookies: { session: "sess-cookie" },
    headers: {
      Authorization: "Bearer admin-tok",
      Cookie: "session=sess-cookie",
      "x-game-secret": "game-sec",
      "X-Reviewer": "reviewer-name",
      "x-forwarded-for": "203.0.113.9",
      "User-Agent": "Mozilla/5.0",
      "content-type": "application/json",
      referer: "https://multiversegames.ai/raising-intelligences/?game=g1&handoff=HC2",
    },
  },
});

describe("stripRequestBody", () => {
  it("removes Authorization, cookies, body and ?token= query; keeps allowlisted headers", () => {
    const out = stripRequestBody(leaky());
    expect(out.request.url).toBe("https://multiversegames.ai/raising-intelligences/api/admin/games");
    expect(out.request).not.toHaveProperty("query_string");
    expect(out.request).not.toHaveProperty("data");
    expect(out.request).not.toHaveProperty("cookies");
    expect(out.request.headers).toEqual({
      "User-Agent": "Mozilla/5.0",
      "content-type": "application/json",
      referer: "https://multiversegames.ai/raising-intelligences/",
    });
    expect(JSON.stringify(out)).not.toMatch(/s3cret|admin-tok|sess-cookie|game-sec|reviewer-name|203\.0|Ada|HC/);
  });
  it("passes an event without a request through untouched", () => {
    expect(stripRequestBody({ message: "boom" } as { message: string; request?: undefined })).toEqual({ message: "boom" });
  });
  it("stripQuery cuts query and fragment, leaves a bare URL alone", () => {
    expect(stripQuery("https://x.test/a?b=1")).toBe("https://x.test/a");
    expect(stripQuery("https://x.test/a#handoff=z")).toBe("https://x.test/a");
    expect(stripQuery("https://x.test/a")).toBe("https://x.test/a");
  });
});

describe("scrubBreadcrumb", () => {
  it("cuts #handoff= from navigation from/to", () => {
    const c = scrubBreadcrumb({ category: "navigation", data: { from: "/raising-intelligences/?game=g1#handoff=HC1", to: "/raising-intelligences/?game=g1" } });
    expect(c.data).toEqual({ from: "/raising-intelligences/", to: "/raising-intelligences/" });
  });
  it("cuts ?token= from a fetch breadcrumb url", () => {
    const c = scrubBreadcrumb({ category: "fetch", data: { method: "GET", url: "https://x.test/api/research/followup?token=s3cret", status_code: 200 } });
    expect(c.data).toEqual({ method: "GET", url: "https://x.test/api/research/followup", status_code: 200 });
  });
  it("drops http.query / http.fragment from a Node outgoing-http breadcrumb", () => {
    const c = scrubBreadcrumb({ category: "http", data: { url: "https://api.test/v1/x", "http.method": "GET", "http.query": "?key=s3cret", "http.fragment": "#f" } });
    expect(c.data).toEqual({ url: "https://api.test/v1/x", "http.method": "GET" });
  });
  it("leaves a crumb without data alone", () => {
    expect(scrubBreadcrumb({ message: "click" } as { message: string; data?: undefined })).toEqual({ message: "click" });
  });
  it("scrubEvent also trims breadcrumbs already attached to the event", () => {
    const ev = scrubEvent({ ...leaky(), breadcrumbs: [{ data: { to: "/?handoff=HC3" } }, { data: { url: "/a?token=s3cret" } }] });
    expect(JSON.stringify(ev)).not.toMatch(/HC|s3cret|admin-tok/);
  });
});
