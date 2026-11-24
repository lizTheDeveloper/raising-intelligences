import type { HostTools } from "./service.js";
import type { ShareService } from "./share.js";
import type { HostEvent, Slot } from "./types.js";
import type { EventRun } from "../stranger/store.js";
import { liveTerms } from "./card.js";

export type LearningAnswer = "yes" | "no";
export interface LearningView { answered: boolean }

/**
 * "Can the studio learn from your game?" (spec B.5, H18), at studio events
 * whose frozen card promised it. Each seat answers once, and nobody is told
 * what anyone else chose: the reply is the same whatever the answer. The
 * studio may read a game only when both said yes and the game isn't excluded
 * (the same exclusions as share codes, H15).
 */
export class LearningService {
  constructor(
    private readonly hosts: HostTools,
    private readonly share: ShareService,
  ) {}

  /**
   * The game's run and event, when its event offers studio learning. Its own
   * lookup: a studio event can offer learning without share codes.
   */
  private async context(gameId: string): Promise<{ run: EventRun; event: HostEvent } | null> {
    const seats = await this.hosts.stranger.matching?.runFor(gameId);
    if (!seats?.eventId || seats.discarded) return null;
    const e = this.hosts.eventById(seats.eventId) ?? (await this.hosts.store.getEvent(seats.eventId));
    if (!e || e.kind !== "studio") return null;
    if (!(e.frozenTerms ?? liveTerms(e, this.hosts.live())).learning) return null;
    const run = (await this.hosts.stranger.store.runsForEvent(e.id)).find((r) => r.gameId === gameId);
    return run && !run.discarded ? { run, event: e } : null;
  }

  /** Is studio learning offered in this game at all? */
  async offered(gameId: string): Promise<boolean> {
    return !!(await this.context(gameId));
  }

  /** A seat answers ("yes" | "no"), or asks where it stands ("status"). Null: not available here. */
  async answer(gameId: string, slot: Slot, answer: unknown): Promise<LearningView | null> {
    if (answer !== "yes" && answer !== "no" && answer !== "status") return null;
    if (!(await this.context(gameId))) return null;
    if (answer !== "status") await this.hosts.store.setLearning(gameId, slot, answer, this.hosts.now());
    const mine = (await this.hosts.store.getLearning(gameId)).find((l) => l.slot === slot);
    return { answered: !!mine };
  }

  /** This seat's own answer, for its account page. Null: not offered in this game. */
  async own(gameId: string, slot: Slot): Promise<LearningAnswer | "unanswered" | null> {
    if (!(await this.context(gameId))) return null;
    return (await this.hosts.store.getLearning(gameId)).find((l) => l.slot === slot)?.answer ?? "unanswered";
  }

  /** May the studio read this game? A studio event that offered it, two yeses, and not excluded (H15). */
  async analysisAllowed(gameId: string): Promise<boolean> {
    const ctx = await this.context(gameId);
    if (!ctx || ctx.run.discarded) return false;
    const answers = await this.hosts.store.getLearning(gameId);
    if (answers.length !== 2 || !answers.every((a) => a.answer === "yes")) return false;
    return !(await this.share.excluded(gameId, ctx.run));
  }

  /** Every game the studio may read (GET /api/admin/host-tools/analysis-allowlist). */
  async allowlist(): Promise<string[]> {
    const out: string[] = [];
    for (const gameId of await this.hosts.store.learningGames()) {
      if (await this.analysisAllowed(gameId)) out.push(gameId);
    }
    return out;
  }
}
