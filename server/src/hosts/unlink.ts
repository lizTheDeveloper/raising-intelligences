import { randomUUID } from "crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import { requireAdmin } from "../routes/admin.js";
import { UNLINKED_SEAT_PREFIX, type EventRun } from "../stranger/store.js";
import type { HostTools } from "./service.js";
import type { ShareService } from "./share.js";
import type { LearningService } from "./learning.js";
import type { HostEvent, Slot } from "./types.js";

/**
 * "Take my game off my account" (spec §6). Deleting a stranger game would end
 * it for the co-parent and tip them off, so the studio unlinks the requester
 * instead: the code is voided at once (silently, like a stop); when Liz marks
 * the request done, the requester's acknowledgements, share decision and
 * learning choice go, the run stops naming them, and their seat can't be
 * taken again. The co-parent keeps their copy of the game.
 */
export class UnlinkService {
  constructor(
    private readonly hosts: HostTools,
    private readonly share: ShareService,
  ) {}

  /** The player asks. Idempotent: one open request per seat. */
  async request(subject: string, seat: { run: EventRun; slot: Slot; event: HostEvent }): Promise<void> {
    if (!(await this.pending(subject, seat.run.gameId))) {
      await this.hosts.store.addUnlink({ id: randomUUID(), gameId: seat.run.gameId, subject, at: this.hosts.now(), doneAt: null });
    }
    await this.share.stop(seat.run.gameId, seat.slot);
  }

  async pending(subject: string, gameId: string): Promise<boolean> {
    return (await this.hosts.store.listUnlinks()).some((u) => u.gameId === gameId && u.subject === subject && u.doneAt === null);
  }

  /** Liz's queue: no subject, no Matrix id, no game id. */
  async list(): Promise<Array<{ id: string; at: number; doneAt: number | null; event: string | null }>> {
    const out = [];
    for (const u of await this.hosts.store.listUnlinks()) {
      const run = await this.hosts.stranger.store.getRun(u.gameId);
      const event = run?.eventId ? (this.hosts.eventById(run.eventId) ?? (await this.hosts.store.getEvent(run.eventId))) : null;
      out.push({ id: u.id, at: u.at, doneAt: u.doneAt, event: event?.name ?? null });
    }
    return out;
  }

  /** Performs the unlink. False when there is no such open request. */
  async done(id: string): Promise<boolean> {
    const u = await this.hosts.store.getUnlink(id);
    if (!u || u.doneAt !== null) return false;
    const stranger = this.hosts.stranger;
    const run = await stranger.store.getRun(u.gameId);
    const slot: Slot | null = run?.parent1 === u.subject ? "parent1" : run?.parent2 === u.subject ? "parent2" : null;
    if (run && slot) {
      await this.share.stop(u.gameId, slot);
      if (run.eventId) await this.hosts.store.deleteAcks(u.subject, run.eventId);
      await this.hosts.store.deleteDecisions(u.gameId, slot);
      await this.hosts.store.deleteLearning(u.gameId, slot);
      await stranger.store.unlinkRunSeat(u.gameId, slot, `${UNLINKED_SEAT_PREFIX}${u.id}`);
      stranger.matching?.forgetSeats(u.gameId);
      stranger.onSeatUnlinked?.(u.gameId, slot);
    }
    return this.hosts.store.markUnlinkDone(id, this.hosts.now());
  }

  /** The account a placeholder seat subject was, for a report filed after the unlink. */
  async originalSubject(placeholder: string): Promise<string | null> {
    if (!placeholder.startsWith(UNLINKED_SEAT_PREFIX)) return null;
    return (await this.hosts.store.getUnlink(placeholder.slice(UNLINKED_SEAT_PREFIX.length)))?.subject ?? null;
  }
}

/** Liz's admin for learning, unlinks and the purge (ADMIN_TOKEN). Works whatever the mode. */
export function createHostToolsReviewRoutes(hosts: HostTools, learning: LearningService, unlink: UnlinkService): Router {
  const router = Router();
  router.use("/admin/host-tools", requireAdmin, (_req: Request, res: Response, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // Games the studio may read: studio events, both said yes, not excluded (H15, H18).
  router.get("/admin/host-tools/analysis-allowlist", async (_req: Request, res: Response) => {
    await hosts.ready;
    res.json({ games: await learning.allowlist() });
  });

  router.get("/admin/host-tools/unlink-requests", async (_req: Request, res: Response) => {
    await hosts.ready;
    res.json({ requests: await unlink.list() });
  });
  router.post("/admin/host-tools/unlink-requests/:id/done", async (req: Request, res: Response) => {
    await hosts.ready;
    const ok = await unlink.done(String(req.params.id));
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "No such open request" });
  });

  // The §10 schedule. Only counts come back.
  router.post("/admin/host-tools/purge", async (_req: Request, res: Response) => {
    await hosts.ready;
    res.json({ deleted: await hosts.purge() });
  });

  return router;
}
