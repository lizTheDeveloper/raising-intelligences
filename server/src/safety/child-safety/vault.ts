import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";
import { captureException } from "../../observability/sentry.js";
import { childSafetyConfig, daysFrom } from "./config.js";
import { decryptEvidence, encryptEvidence, NO_KEY_ID, sha256Hex } from "./crypto.js";
import type { CaseRow, CaseStatus, ChildSafetyStore, Identifier, IpLogEntry } from "./store.js";

/**
 * Child-safety evidence vault: the policy layer over ChildSafetyStore.
 *
 * Lifecycle of a case:
 *   open      — created automatically by a flag. Never purged.
 *   dismissed — a reviewer judged it a false positive (reason required).
 *               Purged CHILD_SAFETY_DISMISSED_RETENTION_DAYS (90) later.
 *   confirmed — a reviewer judged it reportable. Locked: never purged; the
 *               linked IPs and identifiers are banned and cannot be unbanned.
 *   reported  — a human filed it at report.cybertip.org and recorded the
 *               report id. Still locked; retain_until runs one year (or the
 *               configured longer period) from the report date.
 *   released  — after retain_until, a human may release the hold; the case
 *               then becomes purgeable. Nothing releases a hold automatically.
 *
 * Nothing in this module contacts NCMEC or law enforcement. A human files.
 */

export interface ContextTurn {
  speaker: string;
  content: string;
  at?: number | null;
  label?: string | null;
}

export interface EvidenceInput {
  /** ri_message | ri_scene | ri_legacy_flag | whispers | tsb | breach | llm_proxy | synthetic_test */
  source: string;
  /** The flagged content itself. */
  content: string;
  /** The turns before it (oldest first), for context. */
  context: ContextTurn[];
  categories: string[];
  /** Classifier scores, e.g. OpenAI category_scores. */
  scores?: Record<string, number> | null;
  /** Classifier and version, e.g. "omni-moderation-2024-09-26" or "scene-reader:<model>". */
  model?: string | null;
  reason?: string | null;
  gameRef: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** Account / Matrix / email identifiers known for the uploader. */
  identifiers?: Identifier[];
  incidentAt?: number;
  /** Idempotency key (legacy flag id, or a caller id from another service). */
  externalRef?: string | null;
  isTest?: boolean;
  /** Anything source-specific worth keeping (sender slot, phase, service name). */
  extra?: Record<string, unknown>;
}

export interface EvidencePayload {
  version: 1;
  source: string;
  content: string;
  contentSha256: string;
  context: ContextTurn[];
  categories: string[];
  scores: Record<string, number> | null;
  model: string | null;
  reason: string | null;
  gameRef: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  identifiers: Identifier[];
  incidentAt: number;
  preservedAt: number;
  /** The game's IP log at preservation time (every IP seen for this game within the IP-log window). */
  ipHistory: IpLogEntry[];
  extra: Record<string, unknown>;
}

/** Case metadata as listed to a reviewer — never includes content or ciphertext. */
export type CaseSummary = Omit<CaseRow, "ciphertext" | "keyId"> & { encrypted: boolean };

export class VaultError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

function summarize(c: CaseRow): CaseSummary {
  const { ciphertext: _c, keyId, ...rest } = c;
  return { ...rest, encrypted: keyId !== NO_KEY_ID };
}

function requireActor(actor: string): string {
  const a = (actor ?? "").trim();
  if (!a || a.length > 100) throw new VaultError("a reviewer name is required (X-Reviewer header)", 400);
  return a;
}

function dedupeIdentifiers(ids: Identifier[]): Identifier[] {
  const seen = new Set<string>();
  const out: Identifier[] = [];
  for (const id of ids) {
    if (!id.value) continue;
    const k = `${id.kind}:${id.value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(id);
  }
  return out;
}

/**
 * Writes an evidence case. One transaction: the case row and its "create"
 * access row. Idempotent on externalRef. Throws on storage failure — callers
 * must then keep the content somewhere else (moderation.ts falls back to the
 * old plaintext moderation_flags row) rather than drop it.
 */
export async function preserveEvidence(
  store: ChildSafetyStore,
  input: EvidenceInput,
  now: number = Date.now(),
): Promise<{ caseId: string; created: boolean }> {
  if (input.externalRef) {
    const existing = await store.findByExternalRef(input.externalRef);
    if (existing) return { caseId: existing, created: false };
  }
  const cfg = childSafetyConfig();
  const ipHistory = input.gameRef
    ? await store.ipLogForGame(input.gameRef, now - cfg.ipLogRetentionDays * 24 * 60 * 60 * 1000)
    : [];

  const identifiers = dedupeIdentifiers([
    ...(input.ipAddress ? [{ kind: "ip", value: input.ipAddress }] : []),
    ...ipHistory.map((e) => ({ kind: "ip", value: e.ip })),
    ...ipHistory.filter((e) => e.accountId).map((e) => ({ kind: "matrix", value: e.accountId as string })),
    ...(input.identifiers ?? []),
  ]);
  const userAgent = input.userAgent ?? [...ipHistory].reverse().find((e) => e.userAgent)?.userAgent ?? null;

  const contentSha256 = sha256Hex(input.content);
  const payload: EvidencePayload = {
    version: 1,
    source: input.source,
    content: input.content,
    contentSha256,
    context: input.context.slice(-cfg.contextTurns),
    categories: input.categories,
    scores: input.scores ?? null,
    model: input.model ?? null,
    reason: input.reason ?? null,
    gameRef: input.gameRef,
    ipAddress: input.ipAddress,
    userAgent,
    identifiers,
    incidentAt: input.incidentAt ?? now,
    preservedAt: now,
    ipHistory,
    extra: input.extra ?? {},
  };
  const { keyId, ciphertext } = encryptEvidence(JSON.stringify(payload));
  const caseId = randomUUID();
  const row: CaseRow = {
    id: caseId,
    source: input.source,
    status: "open",
    categories: input.categories,
    gameRef: input.gameRef,
    ipAddress: input.ipAddress,
    identifiers,
    incidentAt: payload.incidentAt,
    createdAt: now,
    contentSha256,
    keyId,
    ciphertext,
    externalRef: input.externalRef ?? null,
    isTest: input.isTest ?? false,
    locked: false,
    retainUntil: null,
    purgeAfter: null,
    dismissedAt: null,
    dismissedBy: null,
    dismissReason: null,
    confirmedAt: null,
    confirmedBy: null,
    reportedAt: null,
    reportedBy: null,
    cybertipReportId: null,
  };
  await store.insertCase(row, {
    caseId, actor: "system", action: "create", actorIp: null, detail: input.source, at: now,
  });

  // Content never goes to logs; the case id is the handle.
  logger.error("child_safety_case_opened", {
    caseId, source: input.source, gameRef: input.gameRef, categories: input.categories, test: row.isTest,
  });
  if (keyId === NO_KEY_ID) {
    const err = new Error("CHILD_SAFETY_EVIDENCE_KEY is not set: evidence stored unencrypted");
    logger.error("child_safety_key_missing", { caseId });
    captureException(err, { tags: { component: "child_safety" } });
  }
  return { caseId, created: true };
}

async function mustGet(store: ChildSafetyStore, caseId: string): Promise<CaseRow> {
  const c = await store.getCase(caseId);
  if (!c) throw new VaultError("case not found", 404);
  return c;
}

export async function listCases(
  store: ChildSafetyStore,
  opts: { statuses?: CaseStatus[]; limit: number; offset: number },
  actor: string,
  actorIp: string | null,
  now: number = Date.now(),
): Promise<{ cases: CaseSummary[]; total: number }> {
  const who = requireActor(actor);
  await store.appendAccess({
    caseId: null, actor: who, action: "list", actorIp, detail: opts.statuses?.join(",") ?? "all", at: now,
  });
  const { cases, total } = await store.listCases(opts);
  return { cases: cases.map(summarize), total };
}

/**
 * Decrypts a case for a reviewer. The access row is written BEFORE the
 * decrypt: if the log write fails, nothing is shown.
 */
export async function viewEvidence(
  store: ChildSafetyStore,
  caseId: string,
  actor: string,
  actorIp: string | null,
  now: number = Date.now(),
  action: "view" | "export" = "view",
): Promise<{ case: CaseSummary; evidence: EvidencePayload }> {
  const who = requireActor(actor);
  const c = await mustGet(store, caseId);
  await store.appendAccess({ caseId, actor: who, action, actorIp, detail: null, at: now });
  const evidence = JSON.parse(decryptEvidence(c.keyId, c.ciphertext)) as EvidencePayload;
  return { case: summarize(c), evidence };
}

export async function dismissCase(
  store: ChildSafetyStore,
  caseId: string,
  actor: string,
  actorIp: string | null,
  reason: string,
  now: number = Date.now(),
): Promise<CaseSummary> {
  const who = requireActor(actor);
  const why = (reason ?? "").trim();
  if (!why) throw new VaultError("a dismissal reason is required", 400);
  const c = await mustGet(store, caseId);
  if (c.status !== "open") throw new VaultError(`cannot dismiss a ${c.status} case`, 409);
  const purgeAfter = daysFrom(now, childSafetyConfig().dismissedRetentionDays);
  await store.updateCase(
    caseId,
    { status: "dismissed", dismissedAt: now, dismissedBy: who, dismissReason: why.slice(0, 2000), purgeAfter },
    { caseId, actor: who, action: "dismiss", actorIp, detail: why.slice(0, 500), at: now },
  );
  return summarize(await mustGet(store, caseId));
}

/**
 * Confirms a case as reportable: locks it from purge, starts the retention
 * clock, and bans every linked IP and identifier. `banIp` is the game's own
 * IP ban (banned_ips); identifiers also go to child_safety.banned_identifiers,
 * which blocks an admin unban. Synthetic test cases record the confirm but
 * ban nothing.
 */
export async function confirmCase(
  store: ChildSafetyStore,
  caseId: string,
  actor: string,
  actorIp: string | null,
  banIp: (ip: string, reason: string) => Promise<void>,
  now: number = Date.now(),
): Promise<CaseSummary & { banned: Identifier[] }> {
  const who = requireActor(actor);
  const c = await mustGet(store, caseId);
  if (c.status !== "open" && c.status !== "dismissed") {
    throw new VaultError(`cannot confirm a ${c.status} case`, 409);
  }
  const retainUntil = daysFrom(now, childSafetyConfig().confirmedRetentionDays);
  await store.updateCase(
    caseId,
    {
      status: "confirmed", locked: true, purgeAfter: null, retainUntil, confirmedAt: now, confirmedBy: who,
      dismissedAt: null, dismissedBy: null, dismissReason: null,
    },
    { caseId, actor: who, action: "confirm", actorIp, detail: null, at: now },
  );
  const banned: Identifier[] = [];
  if (!c.isTest) {
    const reason = `child_safety_case:${caseId}`;
    for (const id of c.identifiers) {
      if (id.kind === "ip") await banIp(id.value, reason);
      await store.banIdentifier(id, reason, caseId);
      banned.push(id);
    }
    await store.appendAccess({
      caseId, actor: who, action: "ban", actorIp, detail: banned.map((b) => b.kind).join(","), at: now,
    });
  }
  return { ...summarize(await mustGet(store, caseId)), banned };
}

export async function markReported(
  store: ChildSafetyStore,
  caseId: string,
  actor: string,
  actorIp: string | null,
  cybertipReportId: string,
  now: number = Date.now(),
): Promise<CaseSummary> {
  const who = requireActor(actor);
  const rid = (cybertipReportId ?? "").trim();
  if (!rid) throw new VaultError("the CyberTipline report number is required", 400);
  const c = await mustGet(store, caseId);
  if (c.status !== "confirmed") throw new VaultError(`only a confirmed case can be marked reported (this one is ${c.status})`, 409);
  // 18 U.S.C. 2258A(h): preserve for one year after the report is submitted.
  const retainUntil = Math.max(c.retainUntil ?? 0, daysFrom(now, childSafetyConfig().confirmedRetentionDays));
  await store.updateCase(
    caseId,
    { status: "reported", reportedAt: now, reportedBy: who, cybertipReportId: rid.slice(0, 200), retainUntil, locked: true },
    { caseId, actor: who, action: "reported", actorIp, detail: rid.slice(0, 200), at: now },
  );
  return summarize(await mustGet(store, caseId));
}

/** Human-only: ends the hold on a confirmed/reported case once retain_until has passed. */
export async function releaseHold(
  store: ChildSafetyStore,
  caseId: string,
  actor: string,
  actorIp: string | null,
  now: number = Date.now(),
): Promise<CaseSummary> {
  const who = requireActor(actor);
  const c = await mustGet(store, caseId);
  if (c.status !== "confirmed" && c.status !== "reported") throw new VaultError(`no hold to release on a ${c.status} case`, 409);
  if (c.retainUntil === null || now < c.retainUntil) {
    throw new VaultError(`case is held until ${new Date(c.retainUntil ?? 0).toISOString()}`, 409);
  }
  await store.updateCase(
    caseId,
    { status: "released", locked: false, purgeAfter: now },
    { caseId, actor: who, action: "release", actorIp, detail: null, at: now },
  );
  return summarize(await mustGet(store, caseId));
}

/** Deletes a synthetic test case. Refuses any real case. */
export async function deleteTestCase(
  store: ChildSafetyStore,
  caseId: string,
  actor: string,
  actorIp: string | null,
  now: number = Date.now(),
): Promise<void> {
  const who = requireActor(actor);
  const c = await mustGet(store, caseId);
  if (!c.isTest) throw new VaultError("only synthetic test cases can be deleted", 403);
  await store.deleteCase(caseId, { caseId, actor: who, action: "delete_test", actorIp, detail: null, at: now });
}

export async function caseAccessLog(store: ChildSafetyStore, caseId: string, actor: string, actorIp: string | null, now: number = Date.now()) {
  const who = requireActor(actor);
  const log = await store.listAccess(caseId);
  await store.appendAccess({ caseId, actor: who, action: "access_log", actorIp, detail: null, at: now });
  return log;
}

/** Retention sweep: dismissed/released cases past purge_after, and IP-log rows past the window. */
export async function purgeExpired(store: ChildSafetyStore, now: number = Date.now()) {
  const cutoff = now - childSafetyConfig().ipLogRetentionDays * 24 * 60 * 60 * 1000;
  const result = await store.purge(now, cutoff);
  if (result.purgedCaseIds.length || result.ipRowsDeleted) {
    logger.info("child_safety_purge", { cases: result.purgedCaseIds.length, ipRows: result.ipRowsDeleted });
  }
  return result;
}

/**
 * Records IP + time for a game event. Never throws: an IP-log failure must not
 * break play, but it is logged.
 */
export async function logIp(
  store: ChildSafetyStore,
  entry: { ip: string | null | undefined; gameRef: string | null; event: string; userAgent?: string | null; accountId?: string | null },
  now: number = Date.now(),
): Promise<void> {
  if (!entry.ip) return;
  try {
    await store.insertIpLog({
      ip: entry.ip,
      gameRef: entry.gameRef,
      event: entry.event,
      userAgent: entry.userAgent ? entry.userAgent.slice(0, 512) : null,
      accountId: entry.accountId ?? null,
      at: now,
    });
  } catch (err) {
    logger.error("child_safety_ip_log_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
