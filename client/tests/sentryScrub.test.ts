// Client copy of the server's allowlist scrub (see client/src/sentryScrub.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripRequestBody, scrubBreadcrumb, scrubEvent } from "../src/sentryScrub.js";

test("browser events lose query, #handoff fragment, cookies, body and non-allowlisted headers", () => {
  const out = stripRequestBody({
    request: {
      url: "https://multiversegames.ai/raising-intelligences/?game=g1&token=s3cret#handoff=HC",
      query_string: "token=s3cret",
      data: "body-text",
      cookies: { c: "cookie-val" },
      headers: {
        Authorization: "Bearer tok-val",
        Cookie: "c=cookie-val",
        "User-Agent": "Mozilla/5.0",
        Referer: "https://multiversegames.ai/raising-intelligences/?handoff=HC2",
      },
    },
  });
  assert.equal(out.request.url, "https://multiversegames.ai/raising-intelligences/");
  assert.deepEqual(out.request.headers, {
    "User-Agent": "Mozilla/5.0",
    Referer: "https://multiversegames.ai/raising-intelligences/",
  });
  assert.equal("data" in out.request, false);
  assert.equal("cookies" in out.request, false);
  assert.equal("query_string" in out.request, false);
  assert.doesNotMatch(JSON.stringify(out), /s3cret|HC|cookie-val|tok-val|body-text/);
});

test("navigation breadcrumb loses the #handoff= code", () => {
  const c = scrubBreadcrumb({
    category: "navigation",
    data: { from: "https://multiversegames.ai/raising-intelligences/?game=g1#handoff=HC9", to: "https://multiversegames.ai/raising-intelligences/?game=g1" },
  });
  assert.deepEqual(c.data, {
    from: "https://multiversegames.ai/raising-intelligences/",
    to: "https://multiversegames.ai/raising-intelligences/",
  });
});

test("fetch breadcrumb loses ?token=", () => {
  const c = scrubBreadcrumb({ category: "fetch", data: { method: "GET", url: "/raising-intelligences/api/x?token=s3cret", status_code: 500 } });
  assert.deepEqual(c.data, { method: "GET", url: "/raising-intelligences/api/x", status_code: 500 });
});

test("scrubEvent trims breadcrumbs carried on the event", () => {
  const ev = scrubEvent({
    breadcrumbs: [
      { category: "navigation", data: { from: "/r/#handoff=HC8", to: "/r/" } },
      { category: "xhr", data: { url: "/r/api?token=s3cret" } },
    ],
  });
  assert.doesNotMatch(JSON.stringify(ev), /HC8|s3cret/);
});
