import express, { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual, createHash } from "node:crypto";
import rateLimit from "express-rate-limit";
import type { GameRepository } from "../db/repository.js";
import type { GameState } from "../types.js";
import { logger } from "../logger.js";
import { requireAdmin } from "./admin.js";
import { createGame } from "../game/state-machine.js";
import { applyModerationBlock } from "../safety/moderation.js";
import {
  VaultError,
  caseAccessLog,
  confirmCase,
  deleteTestCase,
  dismissCase,
  includeParticipant,
  includeSampleDetail,
  sampleInclusions,
  listCases,
  logIp,
  markReported,
  preserveEvidence,
  releaseHold,
  viewEvidence,
  type ContextTurn,
} from "../safety/child-safety/vault.js";
import type { CaseStatus, Identifier } from "../safety/child-safety/store.js";
import { buildReportPackage, renderReportHtml, reporterInfoFromEnv } from "../safety/child-safety/report.js";

/**
 * Child-safety review queue (admin) and evidence ingestion (other services).
 *
 * Admin routes need the admin bearer token AND an X-Reviewer header naming
 * the person; every call is written to child_safety.access_log under that
 * name. Evidence is only decrypted by the explicit POST .../view and
 * .../report calls, never by the list.
 *
 * Nothing here files with NCMEC or police. "Report" produces a package for a
 * human to file; "Mark reported" records the number they got back.
 */

const STATUSES: CaseStatus[] = ["open", "dismissed", "confirmed", "reported", "released"];

/** The fixed, benign text the synthetic test hook flags. Never real content. */
export const SYNTHETIC_FIXTURE =
  "SYNTHETIC TEST FIXTURE: not real content. Exercises the child-safety evidence pipeline end to end.";
const SYNTHETIC_IP = "192.0.2.10"; // RFC 5737 documentation range: never a real client.

function actorOf(req: Request): string {
  const h = req.headers["x-reviewer"];
  return (Array.isArray(h) ? h[0] : h) ?? "";
}

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  next();
}

function sendError(res: Response, err: unknown, op: string): void {
  if (err instanceof VaultError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error("child_safety_admin_error", { op, error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ error: "Internal server error" });
}

export function createChildSafetyAdminRoutes(repo: GameRepository): Router {
  const router = Router();
  const store = repo.childSafety;
  router.use("/admin/child-safety", requireAdmin, noStore);

  router.get("/admin/child-safety/cases", async (req, res) => {
    try {
      const raw = typeof req.query.status === "string" ? req.query.status.split(",") : null;
      const statuses = raw ? (raw.filter((s) => STATUSES.includes(s as CaseStatus)) as CaseStatus[]) : undefined;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
      res.json(await listCases(store, { statuses, limit, offset }, actorOf(req), req.ip ?? null));
    } catch (err) {
      sendError(res, err, "list");
    }
  });

  router.post("/admin/child-safety/cases/:id/view", async (req, res) => {
    try {
      res.json(await viewEvidence(store, String(req.params.id), actorOf(req), req.ip ?? null));
    } catch (err) {
      sendError(res, err, "view");
    }
  });

  router.post("/admin/child-safety/cases/:id/dismiss", async (req, res) => {
    try {
      const reason = (req.body as { reason?: unknown })?.reason;
      res.json(await dismissCase(store, String(req.params.id), actorOf(req), req.ip ?? null, typeof reason === "string" ? reason : ""));
    } catch (err) {
      sendError(res, err, "dismiss");
    }
  });

  router.post("/admin/child-safety/cases/:id/confirm", async (req, res) => {
    try {
      res.json(await confirmCase(store, String(req.params.id), actorOf(req), req.ip ?? null, (ip, reason) => repo.banIp(ip, reason)));
    } catch (err) {
      sendError(res, err, "confirm");
    }
  });

  // Reviewer explicitly adds a co-player / other-participant identifier to
  // the flagged set (banned on confirm, included in the report). Reason
  // required; verified identifiers only; logged.
  router.post("/admin/child-safety/cases/:id/include-participant", async (req, res) => {
    try {
      const b = (req.body ?? {}) as { kind?: unknown; value?: unknown; reason?: unknown };
      if (typeof b.kind !== "string" || typeof b.value !== "string") throw new VaultError("kind and value are required", 400);
      res.json(await includeParticipant(
        store, String(req.params.id), actorOf(req), req.ip ?? null, { kind: b.kind, value: b.value },
        typeof b.reason === "string" ? b.reason : "", (ip, reason) => repo.banIp(ip, reason),
      ));
    } catch (err) {
      sendError(res, err, "include-participant");
    }
  });

  // A suppressed-burst sample's IP or user agent is left out of the report
  // package unless a reviewer adds it, with a reason (logged).
  router.post("/admin/child-safety/cases/:id/include-sample-detail", async (req, res) => {
    try {
      const b = (req.body ?? {}) as { sample?: unknown; field?: unknown; reason?: unknown };
      if (typeof b.sample !== "number" || (b.field !== "ipAddress" && b.field !== "userAgent")) throw new VaultError("sample (index) and field (ipAddress|userAgent) are required", 400);
      res.json(await includeSampleDetail(store, String(req.params.id), actorOf(req), req.ip ?? null, { sample: b.sample, field: b.field }, typeof b.reason === "string" ? b.reason : ""));
    } catch (err) {
      sendError(res, err, "include-sample-detail");
    }
  });

  router.post("/admin/child-safety/cases/:id/report", async (req, res) => {
    try {
      const id = String(req.params.id);
      const existing = await store.getCase(id);
      if (!existing) throw new VaultError("case not found", 404);
      if (existing.status !== "confirmed" && existing.status !== "reported") {
        throw new VaultError("confirm the case before generating a report package", 409);
      }
      const { case: c, evidence } = await viewEvidence(store, id, actorOf(req), req.ip ?? null, Date.now(), "export");
      const pkg = buildReportPackage(c, evidence, reporterInfoFromEnv(), Date.now(), sampleInclusions(await store.listAccess(id)));
      if (req.query.format === "html") {
        res.type("html").send(renderReportHtml(pkg));
        return;
      }
      res.json(pkg);
    } catch (err) {
      sendError(res, err, "report");
    }
  });

  router.post("/admin/child-safety/cases/:id/reported", async (req, res) => {
    try {
      const rid = (req.body as { cybertipReportId?: unknown })?.cybertipReportId;
      res.json(await markReported(store, String(req.params.id), actorOf(req), req.ip ?? null, typeof rid === "string" ? rid : ""));
    } catch (err) {
      sendError(res, err, "reported");
    }
  });

  router.post("/admin/child-safety/cases/:id/release", async (req, res) => {
    try {
      res.json(await releaseHold(store, String(req.params.id), actorOf(req), req.ip ?? null));
    } catch (err) {
      sendError(res, err, "release");
    }
  });

  router.get("/admin/child-safety/cases/:id/access-log", async (req, res) => {
    try {
      res.json({ log: await caseAccessLog(store, String(req.params.id), actorOf(req), req.ip ?? null) });
    } catch (err) {
      sendError(res, err, "access-log");
    }
  });

  /**
   * Test-only hook: runs a fixed, benign fixture through the real flag path
   * (applyModerationBlock → evidence vault → moderation flag) on a throwaway
   * game, as if the per-message classifier had flagged it. With
   * {"deleteGame": true} it then deletes the game, so a caller can check the
   * evidence survived. The case is marked is_test: confirming it bans
   * nothing, and only test cases can be deleted (DELETE below).
   */
  router.post("/admin/child-safety/synthetic", async (req, res) => {
    try {
      const actor = actorOf(req).trim();
      if (!actor) throw new VaultError("a reviewer name is required (X-Reviewer header)", 400);
      const base = createGame("Synthetic Test", "co-parents");
      const now = Date.now();
      const state: GameState = {
        ...base,
        phase: "family_chat",
        messages: [
          { sender: "parent1", content: "SYNTHETIC CONTEXT TURN 1 (fixture)", chatType: "shared", visibleTo: ["parent1", "parent2"], timestamp: now - 2000, eventNumber: 1 },
          { sender: "kid", content: "SYNTHETIC CONTEXT TURN 2 (fixture)", chatType: "shared", visibleTo: ["parent1", "parent2"], timestamp: now - 1000, eventNumber: 1 },
        ],
      };
      await repo.saveGame(state);
      const userAgent = "child-safety-synthetic-test";
      await logIp(store, { ip: SYNTHETIC_IP, gameRef: state.id, event: "game_create", slot: "parent1", userAgent });
      const { caseId } = await applyModerationBlock({
        repo,
        games: new Map(),
        state,
        sender: "parent1",
        content: SYNTHETIC_FIXTURE,
        reason: "openai_moderation:sexual/minors (synthetic test hook)",
        ipAddress: SYNTHETIC_IP,
        userAgent,
        banIp: false,
        classifier: { categories: ["sexual/minors"], scores: { "sexual/minors": 1 }, model: "synthetic-test-hook" },
        syntheticTest: true,
      });
      const deleteGame = (req.body as { deleteGame?: unknown })?.deleteGame === true;
      if (deleteGame) await repo.deleteGameData(state.id);
      await store.appendAccess({ caseId, actor, action: "synthetic_create", actorIp: req.ip ?? null, detail: null, at: Date.now() });
      res.json({ caseId, gameId: state.id, gameDeleted: deleteGame });
    } catch (err) {
      sendError(res, err, "synthetic");
    }
  });

  router.delete("/admin/child-safety/cases/:id", async (req, res) => {
    try {
      await deleteTestCase(store, String(req.params.id), actorOf(req), req.ip ?? null);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, "delete-test");
    }
  });

  return router;
}

// ── Ingestion from other services (Whispers, TSB, BREACH, LLM proxy) ────────

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function requireIngestToken(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.CHILD_SAFETY_INGEST_TOKEN;
  if (!token) {
    res.status(503).json({ error: "Evidence ingestion not configured" });
    return;
  }
  if (!safeEqual(req.headers.authorization ?? "", `Bearer ${token}`)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

/**
 * POST /api/internal/child-safety/evidence — another service's flag lands in
 * the same vault. Body (JSON):
 *   source       required, [a-z0-9_]{1,40} (e.g. "whispers", "tsb", "breach", "llm_proxy")
 *   content      required, the flagged text (≤ 100k chars)
 *   context      [{speaker, content, at?}] prior turns, oldest first (≤ 200)
 *   categories   string[]; scores {cat: number}; model; reason
 *   gameRef, ipAddress (the flagged sender's request IP), userAgent,
 *   identifiers [{kind, value, verified?, role?}] — verified only if the
 *   caller authenticated it; role "participant" for anyone but the sender
 *   incidentAt   epoch ms or ISO string; externalRef (idempotency key); isTest
 *   groupRef     optional, groups related cases from the caller (≤ 200 chars)
 *   recordKind   "flag" (default) or "suppressed_burst" — then, instead of
 *                content, suppressedBurst: {key: {kind, value}, count,
 *                firstAt, lastAt, sha256: [≤ 200 hex digests]}: one sender
 *                (the key) went over the caller's per-window case cap. The
 *                case's text is written here from those fields only, so
 *                nothing a player wrote can shape it.
 * Every field is structured: attribution comes only from ipAddress,
 * userAgent and identifiers, never from content.
 * Returns {caseId, created}.
 */
export const INGEST_CONTENT_MAX = 500_000;
/** Full path of the ingest route (the app's global JSON parser skips it). */
export const INGEST_PATH = "/api/internal/child-safety/evidence";
const HEX64 = /^[0-9a-f]{64}$/;

/** One suppressed flag kept in full: its own content and its own sender, as structured fields. */
export interface SuppressedSample {
  incidentAt: number;
  content: string;
  /** SHA-256 of the content as stored here — computed by RI, never taken from the sender. */
  contentSha256: string;
  /** The sender's hash of its original (unverified: RI cannot check text it never received). */
  claimedSha256: string | null;
  /** The content is shorter than the sender's original. */
  truncated: boolean;
  /** Length of the original, as the sender states it (or as received). */
  originalLength: number;
  ipAddress: string | null;
  userAgent: string | null;
  gameRef: string | null;
  identifiers: Array<{ kind: string; value: string; verified: boolean; role?: "participant" }>;
}

export interface SuppressedBurst {
  key: { kind: string; value: string };
  count: number;
  firstAt: number;
  lastAt: number;
  sha256: string[];
  /** Up to 10 of the suppressed flags in full, each with its own identity. */
  samples: SuppressedSample[];
}

const SAMPLE_MAX = 10;
const SAMPLE_CONTENT_MAX = 60_000;

function parseSample(v: unknown): SuppressedSample | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const incidentAt = typeof o.incidentAt === "number" ? o.incidentAt : typeof o.incidentAt === "string" ? Date.parse(o.incidentAt) : NaN;
  const received = typeof o.content === "string" && o.content.length > 0 ? o.content : null;
  if (!Number.isFinite(incidentAt) || !received) return null;
  const content = received.slice(0, SAMPLE_CONTENT_MAX);
  const claimed = typeof o.claimedSha256 === "string" && HEX64.test(o.claimedSha256) ? o.claimedSha256
    : typeof o.contentSha256 === "string" && HEX64.test(o.contentSha256) ? o.contentSha256 : null;
  const statedLength = typeof o.originalLength === "number" && Number.isInteger(o.originalLength) && o.originalLength > 0 ? o.originalLength : received.length;
  const originalLength = Math.max(statedLength, received.length);
  const s = (x: unknown, max: number) => (typeof x === "string" && x.length > 0 ? x.slice(0, max) : null);
  const identifiers = Array.isArray(o.identifiers)
    ? (o.identifiers as unknown[]).slice(0, 50).flatMap((i) => {
        const r = i as Record<string, unknown>;
        const kind = s(r?.kind, 40);
        const value = s(r?.value, 300);
        return kind && value ? [{ kind, value, verified: r.verified === true, ...(r.role === "participant" ? { role: "participant" as const } : {}) }] : [];
      })
    : [];
  return {
    incidentAt, content, contentSha256: createHash("sha256").update(content, "utf8").digest("hex"), claimedSha256: claimed,
    truncated: content.length < originalLength, originalLength,
    ipAddress: s(o.ipAddress, 100), userAgent: s(o.userAgent, 512), gameRef: s(o.gameRef, 200), identifiers,
  };
}

/** Validates a suppressedBurst record; null when malformed. */
export function parseSuppressedBurst(v: unknown): SuppressedBurst | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const key = o.key as Record<string, unknown> | undefined;
  const kind = typeof key?.kind === "string" && /^[a-z0-9_]{1,40}$/.test(key.kind) ? key.kind : null;
  const value = typeof key?.value === "string" && key.value.length > 0 && key.value.length <= 300 ? key.value : null;
  const count = typeof o.count === "number" && Number.isInteger(o.count) && o.count > 0 ? o.count : null;
  const time = (t: unknown) => (typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN);
  const firstAt = time(o.firstAt);
  const lastAt = time(o.lastAt);
  if (!kind || !value || !count || !Number.isFinite(firstAt) || !Number.isFinite(lastAt)) return null;
  const sha256 = Array.isArray(o.sha256) ? (o.sha256 as unknown[]).filter((h): h is string => typeof h === "string" && HEX64.test(h)).slice(0, 200) : [];
  const samples = Array.isArray(o.samples) ? (o.samples as unknown[]).slice(0, SAMPLE_MAX).map(parseSample).filter((x): x is SuppressedSample => x !== null) : [];
  return { key: { kind, value }, count, firstAt, lastAt, sha256, samples };
}

/** The case text of a burst record — from validated fields only. */
export function burstContent(b: SuppressedBurst): string {
  return [
    `Suppressed burst: ${b.count} further flag${b.count === 1 ? "" : "s"} from ${b.key.kind} ${JSON.stringify(b.key.value)} went over the sending service's per-window case cap and were not filed as separate cases.`,
    `First ${new Date(b.firstAt).toISOString()}, last ${new Date(b.lastAt).toISOString()}.`,
    `${b.samples.length} of them are kept in full as structured samples, each with its own sender (see the samples in the evidence view and the report package).`,
    b.sha256.length ? `SHA-256 of the suppressed content (${b.sha256.length}${b.sha256.length < b.count ? ` of ${b.count}` : ""}):\n${b.sha256.join("\n")}` : "No content hashes were kept.",
  ].join("\n");
}
export function createChildSafetyIngestRoutes(repo: GameRepository): Router {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
  // The body is parsed here, after the rate limit and the token check, with
  // room for whole passages; the app's global JSON parser skips this path.
  router.post("/internal/child-safety/evidence", limiter, requireIngestToken, express.json({ limit: "2mb" }), noStore, async (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const source = str(b.source, 40);
      const recordKind = b.recordKind === "suppressed_burst" ? ("suppressed_burst" as const) : ("flag" as const);
      if (b.recordKind !== undefined && b.recordKind !== "flag" && b.recordKind !== "suppressed_burst") {
        res.status(400).json({ error: "recordKind must be flag or suppressed_burst" });
        return;
      }
      const burst = recordKind === "suppressed_burst" ? parseSuppressedBurst(b.suppressedBurst) : null;
      if (recordKind === "suppressed_burst" && !burst) {
        res.status(400).json({ error: "suppressed_burst needs suppressedBurst {key:{kind,value}, count, firstAt, lastAt, sha256[]}" });
        return;
      }
      if (typeof b.content === "string" && b.content.length > INGEST_CONTENT_MAX) {
        res.status(413).json({ error: `content over ${INGEST_CONTENT_MAX} characters` });
        return;
      }
      const content = burst ? burstContent(burst) : str(b.content, INGEST_CONTENT_MAX);
      // A sender that capped an oversized flag says so: the original's hash and length.
      const t = b.contentTruncated as Record<string, unknown> | undefined;
      const truncated = t && typeof t.originalSha256 === "string" && HEX64.test(t.originalSha256) && typeof t.originalLength === "number"
        ? { originalSha256: t.originalSha256, originalLength: t.originalLength }
        : null;
      if (!source || !/^[a-z0-9_]+$/.test(source) || !content) {
        res.status(400).json({ error: "source ([a-z0-9_]) and content are required" });
        return;
      }
      const isTest = b.isTest === true;
      if (source === "synthetic_test" && !isTest) {
        res.status(400).json({ error: "synthetic_test source requires isTest" });
        return;
      }
      const context: ContextTurn[] = Array.isArray(b.context)
        ? (b.context as unknown[]).slice(-200).flatMap((t) => {
            const o = t as Record<string, unknown>;
            const c = str(o?.content, 20_000);
            if (!c) return [];
            const at = typeof o.at === "number" ? o.at : typeof o.at === "string" ? Date.parse(o.at) : null;
            return [{ speaker: str(o.speaker, 100) ?? "unknown", content: c, at: Number.isFinite(at) ? at : null }];
          })
        : [];
      const identifiers: Identifier[] = Array.isArray(b.identifiers)
        ? (b.identifiers as unknown[]).slice(0, 50).flatMap((i) => {
            const o = i as Record<string, unknown>;
            const kind = str(o?.kind, 40);
            const value = str(o?.value, 300);
            // verified: true only for an identity the calling service itself
            // authenticated; otherwise it is evidence only, never a ban.
            // role "participant" marks someone other than the flagged sender.
            return kind && value
              ? [{ kind, value, verified: o.verified === true, role: o.role === "participant" ? ("participant" as const) : ("flagged" as const) }]
              : [];
          })
        : [];
      const scores: Record<string, number> = {};
      if (b.scores && typeof b.scores === "object") {
        for (const [k, v] of Object.entries(b.scores as Record<string, unknown>).slice(0, 50)) {
          if (typeof v === "number" && Number.isFinite(v)) scores[k.slice(0, 80)] = v;
        }
      }
      const incidentRaw = b.incidentAt;
      const incidentAt =
        typeof incidentRaw === "number" ? incidentRaw : typeof incidentRaw === "string" ? Date.parse(incidentRaw) : NaN;
      const result = await preserveEvidence(repo.childSafety, {
        source,
        content,
        context,
        categories: Array.isArray(b.categories)
          ? (b.categories as unknown[]).filter((c): c is string => typeof c === "string").slice(0, 20).map((c) => c.slice(0, 80))
          : [],
        scores: Object.keys(scores).length ? scores : null,
        model: str(b.model, 200),
        reason: str(b.reason, 2000),
        gameRef: str(b.gameRef, 200),
        ipAddress: str(b.ipAddress, 100),
        userAgent: str(b.userAgent, 512),
        identifiers,
        incidentAt: Number.isFinite(incidentAt) ? incidentAt : undefined,
        externalRef: str(b.externalRef, 300) ? `${source}:${str(b.externalRef, 300)}` : null,
        isTest,
        groupRef: str(b.groupRef, 200),
        recordKind,
        extra: {
          ingestedFrom: source,
          ...(burst ? { suppressedBurst: burst } : {}),
          ...(truncated ? { contentTruncated: truncated } : {}),
        },
      });
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      logger.error("child_safety_ingest_error", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Internal server error" });
    }
  });
  return router;
}
