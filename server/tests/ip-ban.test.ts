import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, type TestServer } from "./helpers/test-server.js";

describe("IP ban middleware", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer("ip-ban");
  });

  afterAll(async () => {
    await server.stop();
  });

  it("allows requests from an IP that is not banned", async () => {
    const res = await fetch(`${server.baseUrl}/health`, {
      headers: { "X-Forwarded-For": "1.1.1.1" },
    });
    expect(res.status).toBe(200);
  });

  it("blocks every request from a banned IP, not just game routes", async () => {
    await server.memRepo.banIp("6.6.6.6", "test");

    const res = await fetch(`${server.baseUrl}/health`, {
      headers: { "X-Forwarded-For": "6.6.6.6" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Forbidden" });
  });

  it("does not affect other IPs once one is banned", async () => {
    const res = await fetch(`${server.baseUrl}/health`, {
      headers: { "X-Forwarded-For": "7.7.7.7" },
    });
    expect(res.status).toBe(200);
  });
});
