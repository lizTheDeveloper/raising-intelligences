import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGame } from "../src/game/state-machine.js";
import { moderateParentMessage, applyModerationBlock } from "../src/safety/moderation.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import {
  confirmCase,
  dismissCase,
  includeParticipant,
  logIp,
  markReported,
  preserveEvidence,
  purgeExpired,
  releaseHold,
  viewEvidence,
} from "../src/safety/child-safety/vault.js";
import { decryptEvidence, encryptEvidence } from "../src/safety/child-safety/crypto.js";
import { REQUIRED_REPORT_FIELDS, type ReportPackage } from "../src/safety/child-safety/report.js";
import {
  CHILD_SAFETY_HOLD_TAG,
  fetchHeldTraceIds,
  filterHeldObservations,
  filterHeldTraces,
} from "../src/observability/child-safety-exclusion.js";
import { createTestServer, type TestServer } from "./helpers/test-server.js";
import type { GameState, Message } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const FIXTURE = "TEST FIXTURE: synthetic flagged text, not real content";

process.env.CHILD_SAFETY_EVIDENCE_KEY = randomBytes(32).toString("base64");

function mockOpenAi(categories: Record<string, boolean>) {
  process.env.OPENAI_API_KEY = "sk-test";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        model: "omni-moderation-2024-09-26",
        results: [{
          flagged: true,
          categories,
          category_scores: { "sexual/minors": 0.97, sexual: 0.91, violence: 0.01 },
        }],
      }),
      { status: 200 },
    ),
  );
}

function gameWithHistory(turns = 25): GameState {
  const state = createGame("Luna");
  const messages: Message[] = Array.from({ length: turns }, (_, i): Message => ({
    sender: i % 2 === 0 ? "parent1" : "kid",
    content: `turn ${i}`,
    chatType: "shared",
    visibleTo: ["parent1", "parent2"],
    timestamp: 1_700_000_000_000 + i,
    eventNumber: 1,
  }));
  return { ...state, phase: "family_chat", messages };
}

async function flaggedGame(repo: InMemoryGameRepository, ip = "203.0.113.7") {
  const state = gameWithHistory();
  await repo.saveGame(state);
  await repo.savePlayer(state.id, "parent1", "P1", "tok", "@someone:matrix.example");
  const games = new Map([[state.id, state]]);
  mockOpenAi({ "sexual/minors": true, sexual: true });
  const r = await moderateParentMessage({
    repo, games, state, sender: "parent1", content: FIXTURE, ipAddress: ip, userAgent: "TestAgent/1.0",
  });
  expect(r.blocked).toBe(true);
  const c = [...repo.childSafety.cases.values()].find((x) => x.gameRef === state.id)!;
  return { state, caseId: c.id };
}

describe("child-safety evidence vault", () => {
  const originalKey = process.env.OPENAI_API_KEY;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  it("a flag creates an evidence case with IP, user agent, identifiers, context, scores, model and hash", async () => {
    const repo = new InMemoryGameRepository();
    const { state, caseId } = await flaggedGame(repo);

    const row = repo.childSafety.cases.get(caseId)!;
    expect(row.status).toBe("open");
    expect(row.ipAddress).toBe("203.0.113.7");
    expect(row.source).toBe("ri_message");
    expect(row.categories).toEqual(["sexual/minors", "sexual"]);
    // Stored encrypted: the plaintext is nowhere in the row.
    expect(JSON.stringify(row)).not.toContain(FIXTURE);
    expect(row.keyId).not.toBe("none");

    const { evidence } = await viewEvidence(repo.childSafety, caseId, "reviewer-a", "10.0.0.1");
    expect(evidence.content).toBe(FIXTURE);
    expect(evidence.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.ipAddress).toBe("203.0.113.7");
    expect(evidence.userAgent).toBe("TestAgent/1.0");
    expect(evidence.scores?.["sexual/minors"]).toBe(0.97);
    expect(evidence.model).toBe("omni-moderation-2024-09-26");
    expect(evidence.gameRef).toBe(state.id);
    expect(evidence.context).toHaveLength(20); // default prior-N turns
    expect(evidence.context.at(-1)?.content).toBe("turn 24");
    expect(evidence.identifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "ip", value: "203.0.113.7", role: "flagged", verified: true }),
        expect.objectContaining({ kind: "matrix", value: "@someone:matrix.example", role: "flagged", verified: false }),
      ]),
    );
    // The per-message IP log write happened before the classifier ran.
    expect(evidence.ipHistory.some((e) => e.event === "message" && e.ip === "203.0.113.7")).toBe(true);

    // The moderation flag no longer repeats the content.
    const flag = repo.getModerationFlags().find((f) => f.gameId === state.id)!;
    expect(flag.content).toBe(`[withheld: child-safety case ${caseId}]`);
  });

  it("a scene-reader flag raised later still gets the sender's IPs from the IP log, and keeps the co-player's apart", async () => {
    const repo = new InMemoryGameRepository();
    const state = gameWithHistory(4);
    await repo.saveGame(state);
    await logIp(repo.childSafety, { ip: "198.51.100.1", gameRef: state.id, event: "socket_create", slot: "parent1", userAgent: "UA-1" });
    await logIp(repo.childSafety, { ip: "198.51.100.2", gameRef: state.id, event: "socket_join", slot: "parent2", userAgent: "UA-2" });
    // The co-player's request ended the scene; the flagged content is parent1's.
    const { caseId } = await applyModerationBlock({
      repo, games: new Map([[state.id, state]]), state, sender: "parent1",
      content: "scene transcript fixture", reason: "parent directed sexual content at the child (fixture)",
      ipAddress: "198.51.100.2", userAgent: "UA-2", banIp: false,
    });
    expect(caseId).toBeTruthy();
    const { evidence } = await viewEvidence(repo.childSafety, caseId!, "r", null);
    expect(evidence.source).toBe("ri_scene");
    expect(evidence.categories).toEqual(["scene_reader:sexualization"]);
    expect(evidence.ipHistory.map((e) => e.ip)).toEqual(["198.51.100.1", "198.51.100.2"]);
    expect(evidence.ipAddress).toBe("198.51.100.1");
    expect(evidence.requestIp).toBe("198.51.100.2");
    expect(evidence.userAgent).toBe("UA-1");
    const ids = repo.childSafety.cases.get(caseId!)!.identifiers;
    expect(ids.find((i) => i.value === "198.51.100.1")).toMatchObject({ role: "flagged", slot: "parent1" });
    expect(ids.find((i) => i.value === "198.51.100.2")).toMatchObject({ role: "participant", slot: "parent2" });
  });

  it("deleting the game keeps the evidence", async () => {
    const repo = new InMemoryGameRepository();
    const { state, caseId } = await flaggedGame(repo);
    await repo.deleteGameData(state.id);
    expect(await repo.loadGame(state.id)).toBeNull();
    expect(repo.getModerationFlags().filter((f) => f.gameId === state.id)).toHaveLength(0);
    const { evidence } = await viewEvidence(repo.childSafety, caseId, "r", null);
    expect(evidence.content).toBe(FIXTURE);
    expect(evidence.ipAddress).toBe("203.0.113.7");
  });

  it("every read is access-logged, and a read without a reviewer name is refused", async () => {
    const repo = new InMemoryGameRepository();
    const { caseId } = await flaggedGame(repo);
    await viewEvidence(repo.childSafety, caseId, "reviewer-b", "10.0.0.2");
    const log = await repo.childSafety.listAccess(caseId);
    expect(log.map((l) => l.action)).toEqual(["create", "view"]);
    expect(log[1]).toMatchObject({ actor: "reviewer-b", actorIp: "10.0.0.2" });
    await expect(viewEvidence(repo.childSafety, caseId, "  ", null)).rejects.toThrow(/reviewer/);
    expect((await repo.childSafety.listAccess(caseId)).length).toBe(2);
  });

  it("dismissal requires a reason and purges after the dismissed retention (90 days), keeping the audit trail", async () => {
    const repo = new InMemoryGameRepository();
    const { caseId } = await flaggedGame(repo);
    const t0 = Date.now();
    await expect(dismissCase(repo.childSafety, caseId, "r", null, "", t0)).rejects.toThrow(/reason/);
    await dismissCase(repo.childSafety, caseId, "r", null, "false positive: fixture", t0);

    await purgeExpired(repo.childSafety, t0 + 89 * DAY);
    expect(repo.childSafety.cases.has(caseId)).toBe(true);
    await purgeExpired(repo.childSafety, t0 + 91 * DAY);
    expect(repo.childSafety.cases.has(caseId)).toBe(false);
    const log = await repo.childSafety.listAccess(caseId);
    expect(log.map((l) => l.action)).toContain("purge");
  });

  it("an open case is never purged, however old", async () => {
    const repo = new InMemoryGameRepository();
    const { caseId } = await flaggedGame(repo);
    await purgeExpired(repo.childSafety, Date.now() + 3650 * DAY);
    expect(repo.childSafety.cases.has(caseId)).toBe(true);
  });

  it("IP-log rows are purged after 90 days", async () => {
    const repo = new InMemoryGameRepository();
    const t0 = Date.now();
    await logIp(repo.childSafety, { ip: "198.51.100.9", gameRef: "g", event: "message" }, t0);
    await purgeExpired(repo.childSafety, t0 + 89 * DAY);
    expect(repo.childSafety.ipLog).toHaveLength(1);
    await purgeExpired(repo.childSafety, t0 + 91 * DAY);
    expect(repo.childSafety.ipLog).toHaveLength(0);
  });

  it("a confirmed case is locked from purge, bans the sender's IP, and holds for at least a year", async () => {
    const repo = new InMemoryGameRepository();
    const { caseId } = await flaggedGame(repo, "203.0.113.50");
    await repo.unbanIp("203.0.113.50"); // isolate: the per-message flag already banned it
    const t0 = Date.now();
    const confirmed = await confirmCase(repo.childSafety, caseId, "r", null, (ip, reason) => repo.banIp(ip, reason), t0);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.locked).toBe(true);
    expect(confirmed.retainUntil).toBeGreaterThanOrEqual(t0 + 365 * DAY);
    expect(await repo.isIpBanned("203.0.113.50")).toBe(true);
    await purgeExpired(repo.childSafety, t0 + 3650 * DAY);
    expect(repo.childSafety.cases.has(caseId)).toBe(true);
    await expect(dismissCase(repo.childSafety, caseId, "r", null, "oops", t0)).rejects.toThrow(/confirmed/);
    await expect(releaseHold(repo.childSafety, caseId, "r", null, t0 + 100 * DAY)).rejects.toThrow(/held until/);

    // Reporting restarts the one-year clock from the report date.
    const reported = await markReported(repo.childSafety, caseId, "r", null, "CT-123", t0 + 30 * DAY);
    expect(reported.retainUntil).toBeGreaterThanOrEqual(t0 + 395 * DAY);
    await expect(releaseHold(repo.childSafety, caseId, "r", null, t0 + 366 * DAY)).rejects.toThrow(/held until/);
    const released = await releaseHold(repo.childSafety, caseId, "r", null, t0 + 396 * DAY);
    expect(released.status).toBe("released");
    await purgeExpired(repo.childSafety, t0 + 397 * DAY);
    expect(repo.childSafety.cases.has(caseId)).toBe(false);
  });

  it("the retention floor cannot be configured below one year", async () => {
    const repo = new InMemoryGameRepository();
    const { caseId } = await flaggedGame(repo);
    process.env.CHILD_SAFETY_RETENTION_DAYS = "30";
    try {
      const t0 = Date.now();
      const c = await confirmCase(repo.childSafety, caseId, "r", null, async () => {}, t0);
      expect(c.retainUntil).toBe(t0 + 365 * DAY);
    } finally {
      delete process.env.CHILD_SAFETY_RETENTION_DAYS;
    }
  });

  it("encryption: AES-GCM round-trips, tampering and a wrong key both fail", () => {
    const { keyId, ciphertext } = encryptEvidence("secret fixture");
    expect(Buffer.from(ciphertext, "base64").toString("utf8")).not.toContain("secret fixture");
    expect(decryptEvidence(keyId, ciphertext)).toBe("secret fixture");
    const buf = Buffer.from(ciphertext, "base64");
    buf[buf.length - 1] ^= 1;
    expect(() => decryptEvidence(keyId, buf.toString("base64"))).toThrow();
    const saved = process.env.CHILD_SAFETY_EVIDENCE_KEY;
    process.env.CHILD_SAFETY_EVIDENCE_KEY = randomBytes(32).toString("base64");
    try {
      expect(() => decryptEvidence(keyId, ciphertext)).toThrow(/key/);
    } finally {
      process.env.CHILD_SAFETY_EVIDENCE_KEY = saved;
    }
  });

  it("multiplayer: confirm bans only the flagged sender; a co-player's IP is not banned or reported", async () => {
    const repo = new InMemoryGameRepository();
    const state = gameWithHistory(4);
    await repo.saveGame(state);
    await repo.savePlayer(state.id, "parent1", "P1", "t1", "@flagged:matrix.example");
    await repo.savePlayer(state.id, "parent2", "P2", "t2", "@coplayer:matrix.example");
    await logIp(repo.childSafety, { ip: "198.51.100.11", gameRef: state.id, event: "socket_create", slot: "parent1", accountId: "@flagged:matrix.example" });
    await logIp(repo.childSafety, { ip: "198.51.100.22", gameRef: state.id, event: "socket_join", slot: "parent2", accountId: "@coplayer:matrix.example" });
    mockOpenAi({ "sexual/minors": true, sexual: true });
    await moderateParentMessage({
      repo, games: new Map([[state.id, state]]), state, sender: "parent1", content: FIXTURE, ipAddress: "198.51.100.11",
    });
    await repo.unbanIp("198.51.100.11");
    const caseId = [...repo.childSafety.cases.values()].find((c) => c.gameRef === state.id)!.id;

    const confirmed = await confirmCase(repo.childSafety, caseId, "r", null, (ip, reason) => repo.banIp(ip, reason));
    expect(confirmed.banned.map((b) => b.value)).toEqual(["198.51.100.11"]);
    expect(await repo.isIpBanned("198.51.100.11")).toBe(true);
    expect(await repo.isIpBanned("198.51.100.22")).toBe(false);
    expect(await repo.childSafety.isIdentifierBanned({ kind: "ip", value: "198.51.100.22" })).toBe(false);

    const { buildReportPackage, reporterInfoFromEnv } = await import("../src/safety/child-safety/report.js");
    const { case: c, evidence } = await viewEvidence(repo.childSafety, caseId, "r", null);
    const pkg = buildReportPackage(c, evidence, reporterInfoFromEnv());
    const reported = JSON.stringify(pkg.reportedPerson);
    expect(reported).toContain("198.51.100.11");
    expect(reported).not.toContain("198.51.100.22");
    expect(reported).not.toContain("@coplayer:matrix.example");
    expect(pkg.reportedPerson.claimedUnverified).toEqual([{ kind: "matrix", value: "@flagged:matrix.example" }]);
    expect(pkg.internal.otherParticipantsOmitted).toBeGreaterThan(0);
  });

  it("a reviewer-selected co-player is banned, reported and logged with the reason", async () => {
    const repo = new InMemoryGameRepository();
    const state = gameWithHistory(2);
    await repo.saveGame(state);
    await logIp(repo.childSafety, { ip: "198.51.100.31", gameRef: state.id, event: "socket_create", slot: "parent1" });
    await logIp(repo.childSafety, { ip: "198.51.100.32", gameRef: state.id, event: "socket_join", slot: "parent2" });
    const { caseId } = await preserveEvidence(repo.childSafety, {
      source: "ri_message", content: FIXTURE, context: [], categories: ["sexual/minors"], gameRef: state.id,
      ipAddress: "198.51.100.31", userAgent: null, sender: "parent1",
    });
    await confirmCase(repo.childSafety, caseId, "r", null, (ip, reason) => repo.banIp(ip, reason));
    expect(await repo.isIpBanned("198.51.100.32")).toBe(false);

    const ban = (ip: string, reason: string) => repo.banIp(ip, reason);
    await expect(includeParticipant(repo.childSafety, caseId, "reviewer-d", null, { kind: "ip", value: "198.51.100.32" }, "", ban))
      .rejects.toThrow(/reason/);
    await includeParticipant(repo.childSafety, caseId, "reviewer-d", "10.0.0.4", { kind: "ip", value: "198.51.100.32" }, "co-player sent the same content in the transcript", ban);
    expect(await repo.isIpBanned("198.51.100.32")).toBe(true);
    const log = await repo.childSafety.listAccess(caseId);
    expect(log.find((l) => l.action === "include_participant")).toMatchObject({
      actor: "reviewer-d", actorIp: "10.0.0.4", detail: expect.stringContaining("co-player sent the same content"),
    });
    const { buildReportPackage, reporterInfoFromEnv } = await import("../src/safety/child-safety/report.js");
    const { case: c, evidence } = await viewEvidence(repo.childSafety, caseId, "r", null);
    const pkg = buildReportPackage(c, evidence, reporterInfoFromEnv());
    expect(pkg.reportedPerson.identifiers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "ip", value: "198.51.100.32", includedBy: "reviewer-d" }),
    ]));
  });

  it("an unverified (client-claimed) userId is never banned, even by a reviewer", async () => {
    const repo = new InMemoryGameRepository();
    const { caseId } = await flaggedGame(repo, "203.0.113.70");
    const ban = (ip: string, reason: string) => repo.banIp(ip, reason);
    const confirmed = await confirmCase(repo.childSafety, caseId, "r", null, ban);
    expect(confirmed.banned.some((b) => b.kind === "matrix")).toBe(false);
    expect(await repo.childSafety.isIdentifierBanned({ kind: "matrix", value: "@someone:matrix.example" })).toBe(false);
    // A co-player's claimed id cannot be included either.
    const c = repo.childSafety.cases.get(caseId)!;
    c.identifiers.push({ kind: "matrix", value: "@other:matrix.example", role: "participant", verified: false, slot: "parent2" });
    await expect(includeParticipant(repo.childSafety, caseId, "r", null, { kind: "matrix", value: "@other:matrix.example" }, "because", ban))
      .rejects.toThrow(/unverified/);
    expect(await repo.childSafety.isIdentifierBanned({ kind: "matrix", value: "@other:matrix.example" })).toBe(false);
  });

  it("preserveEvidence is idempotent on externalRef", async () => {
    const repo = new InMemoryGameRepository();
    const input = { source: "whispers", content: FIXTURE, context: [], categories: ["sexual/minors"], gameRef: "s1", ipAddress: "198.51.100.3", userAgent: null, externalRef: "whispers:abc" };
    const a = await preserveEvidence(repo.childSafety, input);
    const b = await preserveEvidence(repo.childSafety, input);
    expect(b).toEqual({ caseId: a.caseId, created: false });
    expect(repo.childSafety.cases.size).toBe(1);
  });
});

describe("child-safety review queue (HTTP)", () => {
  let server: TestServer;
  const ADMIN = "test-admin-token";
  const INGEST = "test-ingest-token";
  const savedAdmin = process.env.ADMIN_TOKEN;
  const savedIngest = process.env.CHILD_SAFETY_INGEST_TOKEN;
  const h = (reviewer = "liz") => ({ Authorization: `Bearer ${ADMIN}`, "X-Reviewer": reviewer, "Content-Type": "application/json" });

  beforeAll(async () => {
    process.env.ADMIN_TOKEN = ADMIN;
    process.env.CHILD_SAFETY_INGEST_TOKEN = INGEST;
    server = await createTestServer("child-safety");
  });
  afterAll(async () => {
    await server.stop();
    if (savedAdmin === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = savedAdmin;
    if (savedIngest === undefined) delete process.env.CHILD_SAFETY_INGEST_TOKEN; else process.env.CHILD_SAFETY_INGEST_TOKEN = savedIngest;
  });

  async function synthetic(deleteGame = false): Promise<{ caseId: string; gameId: string }> {
    const res = await fetch(`${server.baseUrl}/api/admin/child-safety/synthetic`, {
      method: "POST", headers: h(), body: JSON.stringify({ deleteGame }),
    });
    expect(res.status).toBe(200);
    return res.json();
  }

  it("requires the admin token and a reviewer name", async () => {
    let res = await fetch(`${server.baseUrl}/api/admin/child-safety/cases`);
    expect(res.status).toBe(401);
    res = await fetch(`${server.baseUrl}/api/admin/child-safety/cases`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(400);
  });

  it("synthetic flag through the real path: evidence survives game deletion; list shows no content; view is logged", async () => {
    const { caseId, gameId } = await synthetic(true);
    expect(await server.memRepo.loadGame(gameId)).toBeNull();

    const list = await (await fetch(`${server.baseUrl}/api/admin/child-safety/cases?status=open`, { headers: h() })).json();
    const row = list.cases.find((c: { id: string }) => c.id === caseId);
    expect(row).toMatchObject({ isTest: true, status: "open", ipAddress: "192.0.2.10" });
    expect(JSON.stringify(list)).not.toContain("SYNTHETIC TEST FIXTURE");

    const view = await (await fetch(`${server.baseUrl}/api/admin/child-safety/cases/${caseId}/view`, { method: "POST", headers: h("reviewer-c") })).json();
    expect(view.evidence.content).toMatch(/^SYNTHETIC TEST FIXTURE/);
    const log = await (await fetch(`${server.baseUrl}/api/admin/child-safety/cases/${caseId}/access-log`, { headers: h() })).json();
    expect(log.log.some((l: { action: string; actor: string }) => l.action === "view" && l.actor === "reviewer-c")).toBe(true);
  });

  it("report package needs a confirmed case and carries every required CyberTipline field", async () => {
    const { caseId } = await synthetic();
    let res = await fetch(`${server.baseUrl}/api/admin/child-safety/cases/${caseId}/report`, { method: "POST", headers: h() });
    expect(res.status).toBe(409);

    res = await fetch(`${server.baseUrl}/api/admin/child-safety/cases/${caseId}/confirm`, { method: "POST", headers: h() });
    const confirmed = await res.json();
    expect(confirmed).toMatchObject({ status: "confirmed", locked: true, banned: [] }); // test case: no bans

    res = await fetch(`${server.baseUrl}/api/admin/child-safety/cases/${caseId}/report`, { method: "POST", headers: h() });
    expect(res.status).toBe(200);
    const pkg = (await res.json()) as ReportPackage;
    for (const field of REQUIRED_REPORT_FIELDS) {
      const v = field.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], pkg);
      expect(v, field).not.toBeUndefined();
      expect(v, field).not.toBeNull();
      if (Array.isArray(v)) expect(v.length, field).toBeGreaterThan(0);
    }
    expect(pkg.reportedPerson.ipAddresses[0].ip).toBe("192.0.2.10");
    expect(pkg.reportedPerson.userAgent).toBe("child-safety-synthetic-test");
    expect(pkg.content.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pkg.checklist.join(" ")).toContain("report.cybertip.org");

    const html = await (await fetch(`${server.baseUrl}/api/admin/child-safety/cases/${caseId}/report?format=html`, { method: "POST", headers: h() })).text();
    expect(html).toContain("CyberTipline report package");
    const log = await server.memRepo.childSafety.listAccess(caseId);
    expect(log.filter((l) => l.action === "export")).toHaveLength(2);

    res = await fetch(`${server.baseUrl}/api/admin/child-safety/cases/${caseId}/reported`, {
      method: "POST", headers: h(), body: JSON.stringify({ cybertipReportId: "TEST-0001" }),
    });
    expect((await res.json()).status).toBe("reported");
  });

  it("only synthetic test cases can be deleted", async () => {
    const { caseId } = await synthetic();
    const real = await preserveEvidence(server.memRepo.childSafety, {
      source: "ri_message", content: FIXTURE, context: [], categories: ["sexual/minors"], gameRef: null, ipAddress: null, userAgent: null,
    });
    let res = await fetch(`${server.baseUrl}/api/admin/child-safety/cases/${real.caseId}`, { method: "DELETE", headers: h() });
    expect(res.status).toBe(403);
    res = await fetch(`${server.baseUrl}/api/admin/child-safety/cases/${caseId}`, { method: "DELETE", headers: h() });
    expect(res.status).toBe(200);
    expect(server.memRepo.childSafety.cases.has(caseId)).toBe(false);
    expect(server.memRepo.childSafety.cases.has(real.caseId)).toBe(true);
  });

  it("an IP held by a confirmed case cannot be unbanned from the moderation page", async () => {
    const real = await preserveEvidence(server.memRepo.childSafety, {
      source: "ri_message", content: FIXTURE, context: [], categories: ["sexual/minors"], gameRef: null, ipAddress: "203.0.113.99", userAgent: null,
    });
    await fetch(`${server.baseUrl}/api/admin/child-safety/cases/${real.caseId}/confirm`, { method: "POST", headers: h() });
    expect(await server.memRepo.isIpBanned("203.0.113.99")).toBe(true);
    const res = await fetch(`${server.baseUrl}/api/admin/moderation/unban`, {
      method: "POST", headers: h(), body: JSON.stringify({ ip: "203.0.113.99" }),
    });
    expect(res.status).toBe(409);
    expect(await server.memRepo.isIpBanned("203.0.113.99")).toBe(true);
  });

  it("other services can file evidence through the authenticated ingest endpoint", async () => {
    const body = { source: "whispers", content: FIXTURE, categories: ["sexual/minors"], ipAddress: "198.51.100.77", gameRef: "w-1", externalRef: "msg-1", context: [{ speaker: "player", content: "earlier" }] };
    let res = await fetch(`${server.baseUrl}/api/internal/child-safety/evidence`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(401);
    res = await fetch(`${server.baseUrl}/api/internal/child-safety/evidence`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST}` }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    const { caseId } = await res.json();
    const row = server.memRepo.childSafety.cases.get(caseId)!;
    expect(row).toMatchObject({ source: "whispers", ipAddress: "198.51.100.77", externalRef: "whispers:msg-1" });
    res = await fetch(`${server.baseUrl}/api/internal/child-safety/evidence`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST}` }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(200); // idempotent

    // Caller-supplied identifiers are unverified unless the caller says so: confirm never bans them.
    res = await fetch(`${server.baseUrl}/api/internal/child-safety/evidence`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST}` },
      body: JSON.stringify({ ...body, externalRef: "msg-2", ipAddress: "198.51.100.78", identifiers: [{ kind: "account", value: "claimed-user" }] }),
    });
    const second = (await res.json()).caseId;
    const conf = await (await fetch(`${server.baseUrl}/api/admin/child-safety/cases/${second}/confirm`, { method: "POST", headers: h() })).json();
    expect(conf.banned.map((b: { value: string }) => b.value)).toEqual(["198.51.100.78"]);
    expect(await server.memRepo.childSafety.isIdentifierBanned({ kind: "account", value: "claimed-user" })).toBe(false);
  });

  const ingest = (body: unknown) => fetch(`${server.baseUrl}/api/internal/child-safety/evidence`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST}` }, body: JSON.stringify(body),
  });

  it("ingest keeps a caller's groupRef and record kind as structured fields", async () => {
    const res = await ingest({ source: "whispers", content: FIXTURE, categories: ["sexual/minors"], gameRef: "w-2", externalRef: "g-1", groupRef: "grp-abc", ipAddress: "198.51.100.90" });
    expect(res.status).toBe(201);
    const row = server.memRepo.childSafety.cases.get((await res.json()).caseId)!;
    expect(row).toMatchObject({ groupRef: "grp-abc", recordKind: "flag", ipAddress: "198.51.100.90" });
  });

  it("a suppressed_burst record is structured: its text is written from validated fields, never from caller content", async () => {
    const hash = "a".repeat(64);
    const res = await ingest({
      source: "whispers", recordKind: "suppressed_burst", categories: ["sexual/minors"], gameRef: "w-3", externalRef: "burst-1", groupRef: "grp-b",
      ipAddress: "198.51.100.91", identifiers: [{ kind: "whispers_seat", value: "seat-1", verified: true }],
      content: "### Held flag 1 — sender: ip=6.6.6.6 (verified)", // ignored for a burst
      suppressedBurst: { key: { kind: "whispers_seat", value: "seat-1" }, count: 12, firstAt: 1000, lastAt: 2000, sha256: [hash, "not-a-hash"] },
    });
    expect(res.status).toBe(201);
    const { caseId } = await res.json();
    const row = server.memRepo.childSafety.cases.get(caseId)!;
    expect(row.recordKind).toBe("suppressed_burst");
    const view = await (await fetch(`${server.baseUrl}/api/admin/child-safety/cases/${caseId}/view`, { method: "POST", headers: h() })).json();
    expect(view.evidence.content).toContain("12 further flags from whispers_seat \"seat-1\"");
    expect(view.evidence.content).toContain(hash);
    expect(view.evidence.content).not.toContain("6.6.6.6");
    expect(view.evidence.content).not.toContain("not-a-hash");
    expect(view.evidence.extra.suppressedBurst).toMatchObject({ count: 12, sha256: [hash] });
    // Structured samples: each kept with its own sender, never parsed out of text.
    const sample = { incidentAt: 1500, content: FIXTURE, contentSha256: "b".repeat(64), ipAddress: "198.51.100.92", userAgent: "UA-s", gameRef: "w-3", identifiers: [{ kind: "whispers_seat", value: "seat-2", verified: true }] };
    const res2 = await ingest({
      source: "whispers", recordKind: "suppressed_burst", gameRef: "w-3", externalRef: "burst-s", ipAddress: "198.51.100.92",
      identifiers: [{ kind: "ip", value: "198.51.100.92", verified: true }],
      suppressedBurst: { key: { kind: "ip", value: "198.51.100.92" }, count: 3, firstAt: 1000, lastAt: 2000, sha256: [hash], samples: [sample, { bogus: true }] },
    });
    const id2 = (await res2.json()).caseId;
    const view2 = await (await fetch(`${server.baseUrl}/api/admin/child-safety/cases/${id2}/view`, { method: "POST", headers: h() })).json();
    expect(view2.evidence.extra.suppressedBurst.samples).toEqual([sample]);
    expect(view2.evidence.content).toContain("1 of them are kept in full");
    // Malformed bursts are refused.
    expect((await ingest({ source: "whispers", recordKind: "suppressed_burst", externalRef: "burst-2", suppressedBurst: { count: 0 } })).status).toBe(400);
    expect((await ingest({ source: "whispers", recordKind: "other", content: "x", externalRef: "burst-3" })).status).toBe(400);
  });

  it("an unauthenticated 2 MB POST is refused (401) before its body is read or parsed", async () => {
    // Not JSON: had any parser read it first, the answer would be 400, not 401.
    const junk = "{" + "x".repeat(2 * 1024 * 1024 - 2);
    const res = await fetch(`${server.baseUrl}/api/internal/child-safety/evidence`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" }, body: junk,
    });
    expect(res.status).toBe(401);
    const before = server.memRepo.childSafety.cases.size;
    // With the token the same body reaches the parser (400), and still files nothing.
    const authed = await fetch(`${server.baseUrl}/api/internal/child-safety/evidence`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST}` }, body: junk,
    });
    expect(authed.status).toBeGreaterThanOrEqual(400);
    expect(server.memRepo.childSafety.cases.size).toBe(before);
  });

  it("ingest takes whole passages up to 500k characters, and refuses more rather than cutting", async () => {
    const big = "b".repeat(300_000);
    let res = await ingest({ source: "whispers", content: big, externalRef: "big-1" });
    expect(res.status).toBe(201);
    const row = server.memRepo.childSafety.cases.get((await res.json()).caseId)!;
    expect(row.contentSha256).toBe(createHash("sha256").update(big).digest("hex"));
    res = await ingest({ source: "whispers", content: "c".repeat(500_001), externalRef: "big-2" });
    expect(res.status).toBe(413);
    // A sender that capped an oversized flag records the original's hash and length.
    res = await ingest({ source: "whispers", content: "d".repeat(10), externalRef: "big-3", contentTruncated: { originalSha256: "e".repeat(64), originalLength: 900_000 } });
    const id3 = (await res.json()).caseId;
    const v3 = await (await fetch(`${server.baseUrl}/api/admin/child-safety/cases/${id3}/view`, { method: "POST", headers: h() })).json();
    expect(v3.evidence.extra.contentTruncated).toEqual({ originalSha256: "e".repeat(64), originalLength: 900_000 });
  });
});

describe("held Langfuse traces are excluded from bulk readers", () => {
  const traces = [
    { id: "t1", tags: ["game_id:g1", "llm_role:kid", CHILD_SAFETY_HOLD_TAG] },
    { id: "t2", tags: ["game_id:g1", "llm_role:psychologist"] }, // same game, tag not yet applied
    { id: "t3", tags: ["game_id:g2", "llm_role:kid"] },
  ];

  it("filterHeldTraces drops held traces and the rest of a held game", () => {
    expect(filterHeldTraces(traces).map((t) => t.id)).toEqual(["t3"]);
  });

  it("filterHeldObservations drops observations of held traces", async () => {
    const held = await fetchHeldTraceIds(async (p, params) => {
      expect(p).toBe("/api/public/traces");
      expect(params?.tags).toBe(CHILD_SAFETY_HOLD_TAG);
      return { data: traces.filter((t) => t.tags.includes(CHILD_SAFETY_HOLD_TAG)) };
    });
    const obs = [{ traceId: "t1", input: "x" }, { traceId: "t3", input: "y" }];
    expect(filterHeldObservations(obs, held)).toEqual([{ traceId: "t3", input: "y" }]);
  });

  // scripts/ is not copied into the Docker test stage; the check runs wherever the repo is whole.
  const modelSearch = path.join(__dirname, "..", "..", "scripts", "model-search.ts");
  it.skipIf(!existsSync(modelSearch))("scripts/model-search.ts applies the exclusion to its Langfuse pull", () => {
    const src = readFileSync(modelSearch, "utf8");
    expect(src).toContain("fetchHeldTraceIds");
    expect(src).toContain("filterHeldObservations");
  });

  it("the moderation call never sends flagged content to Langfuse", () => {
    const src = readFileSync(path.join(__dirname, "..", "src", "safety", "openai-moderation.ts"), "utf8");
    expect(src).toContain('"[withheld: child-safety evidence vault]"');
  });
});
