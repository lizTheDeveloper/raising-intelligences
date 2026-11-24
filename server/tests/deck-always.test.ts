import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { DECK } from "../src/hosts/portal.js";

/**
 * Persona tests (Marisol, finding 10): `?deck=1` is a link a nurse puts on a
 * class handout. It has to load whenever the site is up, whatever the
 * stranger mode, with no account. The deck is static and holds no player
 * data. The host portal and account page stay hidden behind /host/on.
 */
describe("the deck in every mode", () => {
  let built: BuiltServer;
  afterEach(async () => { await built.close(); });

  async function boot(hostTools: null | undefined): Promise<string> {
    built = buildServer({ llm: new MockLLMClient(), repo: new InMemoryGameRepository(), enableEviction: false, allowedOrigin: "*", socketPath: "/socket.io", hostTools });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  }

  for (const [label, hostTools] of [["no host tools at all", null], ["stranger mode off (the default)", undefined]] as const) {
    it(`${label}: the deck is served, with no sign-in; /host/on is not`, async () => {
      const origin = await boot(hostTools);
      const r = await fetch(`${origin}/api/events/deck`);
      expect(r.status).toBe(200);
      expect((await r.json()).deck).toEqual(JSON.parse(JSON.stringify(DECK)));
      const on = await fetch(`${origin}/api/host/on`);
      expect(on.status).not.toBe(200);
    });
  }
});

describe("no third-party fonts", () => {
  let built: BuiltServer;
  afterEach(async () => { await built.close(); });

  it("the CSP allows fonts and styles from this site only: Google never sees a player's IP (finding 17)", async () => {
    built = buildServer({ llm: new MockLLMClient(), repo: new InMemoryGameRepository(), enableEviction: false, allowedOrigin: "*", socketPath: "/socket.io" });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    const origin = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
    const csp = (await fetch(`${origin}/api/events/deck`)).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toMatch(/googleapis|gstatic/);
  });
});
