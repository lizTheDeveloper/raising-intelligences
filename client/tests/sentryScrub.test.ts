// Client copy of the server's allowlist scrub (see client/src/sentryScrub.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripRequestBody } from "../src/sentryScrub.js";

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
