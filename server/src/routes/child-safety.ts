import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
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

  router.post("/admin/child-safety/cases/:id/report", async (req, res) => {
    try {
      const id = String(req.params.id);
      const existing = await store.getCase(id);
      if (!existing) throw new VaultError("case not found", 404);
      if (existing.status !== "confirmed" && existing.status !== "reported") {
        throw new VaultError("confirm the case before generating a report package", 409);
      }
      const { case: c, evidence } = await viewEvidence(store, id, actorOf(req), req.ip ?? null, Date.now(), "export");
      const pkg = buildReportPackage(c, evidence, reporterInfoFromEnv());
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
      await logIp(store, { ip: SYNTHETIC_IP, gameRef: state.id, event: "game_create", userAgent });
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
 *   gameRef, ipAddress, userAgent, identifiers [{kind, value}]
 *   incidentAt   epoch ms or ISO string; externalRef (idempotency key); isTest
 * Returns {caseId, created}.
 */
export function createChildSafetyIngestRoutes(repo: GameRepository): Router {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
  router.post("/internal/child-safety/evidence", limiter, requireIngestToken, noStore, async (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const source = str(b.source, 40);
      const content = str(b.content, 100_000);
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
            return kind && value ? [{ kind, value }] : [];
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
        extra: { ingestedFrom: source },
      });
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      logger.error("child_safety_ingest_error", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Internal server error" });
    }
  });
  return router;
}
