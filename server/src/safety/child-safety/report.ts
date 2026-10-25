import type { CaseSummary, EvidencePayload } from "./vault.js";
import { identifierRole, identifierVerified } from "./store.js";

/**
 * Builds a CyberTipline-ready report package from a confirmed case: the
 * fields NCMEC's CyberTipline report form asks an electronic service provider
 * for, laid out in the order the form asks for them, plus a filing checklist.
 *
 * This produces a document for a HUMAN to file at https://report.cybertip.org
 * (or through the ESP portal once registered). Nothing here submits anything.
 */

export const REQUIRED_REPORT_FIELDS = [
  "reportingEsp",
  "incidentSummary.incidentType",
  "incidentSummary.incidentDateTime",
  "incidentSummary.incidentDescription",
  "reportedPerson.ipAddresses",
  "reportedPerson.userAgent",
  "reportedPerson.identifiers",
  "content.text",
  "content.sha256",
  "content.contextTranscript",
  "content.viewedByEsp",
  "content.publiclyAvailable",
  "internal.caseId",
] as const;

export interface ReporterInfo {
  espName: string;
  espContactName: string | null;
  espContactEmail: string | null;
  service: string;
  serviceUrl: string;
}

export function reporterInfoFromEnv(): ReporterInfo {
  return {
    espName: process.env.CHILD_SAFETY_ESP_NAME ?? "Multiverse Games (Raising Intelligences)",
    espContactName: process.env.CHILD_SAFETY_ESP_CONTACT_NAME ?? null,
    espContactEmail: process.env.CHILD_SAFETY_ESP_CONTACT_EMAIL ?? null,
    service: "Raising Intelligences",
    serviceUrl: "https://multiversegames.ai/raising-intelligences/",
  };
}

export interface ReportPackage {
  generatedAt: string;
  notice: string;
  reportingEsp: ReporterInfo;
  incidentSummary: {
    incidentType: string;
    incidentDateTime: string;
    incidentDescription: string;
    detectionMethod: string;
  };
  reportedPerson: {
    ipAddresses: Array<{ ip: string; capturedAt: string; event: string }>;
    userAgent: string | null;
    /** Verified identifiers of the flagged sender (plus any a reviewer explicitly included). */
    identifiers: Array<{ kind: string; value: string; includedBy?: string; includedReason?: string }>;
    /** IDs the client claimed (e.g. a Matrix userId) — never verified by the service. */
    claimedUnverified: Array<{ kind: string; value: string }>;
    accountVerified: false;
  };
  content: {
    text: string;
    sha256: string;
    contextTranscript: Array<{ speaker: string; content: string; at: string | null }>;
    /** For a suppressed-burst record: the flags kept in full, each with its own sender. */
    suppressedSamples?: Array<{ incidentAt: string; content: string; sha256: string; ipAddress: string | null; userAgent: string | null; gameRef: string | null; identifiers: Array<{ kind: string; value: string; verified: boolean }> }>;
    /** The sender capped an oversized flag: the original's SHA-256 and length (full text kept by the sender). */
    truncatedOriginal?: { sha256: string; length: number };
    locationOnService: string;
    viewedByEsp: true;
    publiclyAvailable: false;
  };
  classifier: { categories: string[]; scores: Record<string, number> | null; model: string | null; reason: string | null };
  internal: {
    caseId: string;
    source: string;
    gameRef: string | null;
    status: string;
    preservedAt: string;
    /** Identifiers seen from other seats in the game and left out of this report. */
    otherParticipantsOmitted: number;
    confirmedAt: string | null;
    confirmedBy: string | null;
    retainUntil: string | null;
  };
  checklist: string[];
}

const iso = (ms: number | null | undefined): string | null => (ms ? new Date(ms).toISOString() : null);

type SampleExtra = { incidentAt: number; content: string; contentSha256: string; ipAddress: string | null; userAgent: string | null; gameRef: string | null; identifiers: Array<{ kind: string; value: string; verified: boolean; role?: string }> };
function suppressedExtras(extra: Record<string, unknown>): Pick<ReportPackage["content"], "suppressedSamples" | "truncatedOriginal"> {
  const burst = extra.suppressedBurst as { samples?: SampleExtra[] } | undefined;
  const trunc = extra.contentTruncated as { originalSha256: string; originalLength: number } | undefined;
  return {
    ...(burst?.samples?.length
      ? { suppressedSamples: burst.samples.map((s) => ({ incidentAt: new Date(s.incidentAt).toISOString(), content: s.content, sha256: s.contentSha256, ipAddress: s.ipAddress, userAgent: s.userAgent, gameRef: s.gameRef, identifiers: s.identifiers.filter((i) => !i.role).map((i) => ({ kind: i.kind, value: i.value, verified: i.verified })) })) }
      : {}),
    ...(trunc ? { truncatedOriginal: { sha256: trunc.originalSha256, length: trunc.originalLength } } : {}),
  };
}

export function buildReportPackage(c: CaseSummary, e: EvidencePayload, reporter: ReporterInfo, now = Date.now()): ReportPackage {
  // Only the flagged sender's identifiers (and any a reviewer explicitly
  // included, with a reason) go in the report. Co-players seen in the same
  // game stay out unless included.
  const flagged = c.identifiers.filter((i) => identifierRole(i, c.ipAddress) === "flagged");
  const flaggedVerified = flagged.filter((i) => identifierVerified(i));
  const flaggedIps = new Set(flaggedVerified.filter((i) => i.kind === "ip").map((i) => i.value));
  const ipAddresses = [
    ...(c.ipAddress && flaggedIps.has(c.ipAddress)
      ? [{ ip: c.ipAddress, capturedAt: new Date(e.incidentAt).toISOString(), event: "flagged_content" }]
      : []),
    ...e.ipHistory
      .filter((h) => flaggedIps.has(h.ip))
      .map((h) => ({ ip: h.ip, capturedAt: new Date(h.at).toISOString(), event: h.event })),
  ];
  const otherParticipants = c.identifiers.length - flagged.length;
  return {
    generatedAt: new Date(now).toISOString(),
    notice:
      "Prepared for a human to file with the NCMEC CyberTipline. Not submitted automatically. " +
      "Contains apparent child sexual exploitation material in text form: handle under the access policy in docs/child-safety.md.",
    reportingEsp: reporter,
    incidentSummary: {
      // The reviewer confirms or changes this on the form; enticement is the
      // usual fit for text chat, apparent CSAM for imagery.
      incidentType: "Online Enticement of Children for Sexual Acts / apparent child sexual exploitation (text) — reviewer to confirm",
      incidentDateTime: new Date(e.incidentAt).toISOString(),
      incidentDescription:
        `A user of ${reporter.service} (an AI parenting simulation in which the player talks with an AI-generated child character) ` +
        `submitted text that the service's automated moderation flagged as ${e.categories.join(", ") || "child sexual content"} ` +
        `and a human reviewer confirmed. Transcript and identifiers attached.`,
      detectionMethod: `${e.source} via ${e.model ?? "automated classifier"}; confirmed by human review`,
    },
    reportedPerson: {
      ipAddresses,
      userAgent: e.userAgent,
      identifiers: flaggedVerified.map((i) => ({
        kind: i.kind, value: i.value,
        ...(i.includedBy ? { includedBy: i.includedBy, includedReason: i.includedReason } : {}),
      })),
      claimedUnverified: flagged.filter((i) => !identifierVerified(i)).map((i) => ({ kind: i.kind, value: i.value })),
      accountVerified: false,
    },
    content: {
      text: e.content,
      sha256: e.contentSha256,
      contextTranscript: e.context.map((t) => ({ speaker: t.speaker, content: t.content, at: iso(t.at ?? null) })),
      ...suppressedExtras(e.extra),
      locationOnService: `In-game chat, game ${e.gameRef ?? "(unknown)"}`,
      viewedByEsp: true,
      publiclyAvailable: false,
    },
    classifier: { categories: e.categories, scores: e.scores, model: e.model, reason: e.reason },
    internal: {
      caseId: c.id,
      source: c.source,
      gameRef: c.gameRef,
      status: c.status,
      preservedAt: new Date(e.preservedAt).toISOString(),
      otherParticipantsOmitted: otherParticipants,
      confirmedAt: iso(c.confirmedAt),
      confirmedBy: c.confirmedBy,
      retainUntil: iso(c.retainUntil),
    },
    checklist: [
      "Sign in to the CyberTipline ESP portal (or https://report.cybertip.org if not yet registered as an ESP).",
      "Incident type: choose the closest category (usually Online Enticement for text chat; Child Pornography if imagery is involved).",
      "Incident date/time: use incidentSummary.incidentDateTime (UTC).",
      "Reporting ESP: fill from reportingEsp.",
      "Reported person: enter every IP in reportedPerson.ipAddresses with its capture time and event, and the user agent. These are the flagged sender's only; co-players are left out unless a reviewer included them. List reportedPerson.claimedUnverified (e.g. a Matrix ID) only as 'claimed by the user, not verified'.",
      "Content: paste content.text and the context transcript as an attached .txt or in Additional Information; give the SHA-256.",
      "Answer 'Did you view the content?' = Yes (a human reviewer viewed it). 'Publicly available?' = No.",
      "Additional information: explain the service (AI child character, no real child in the conversation unless the transcript indicates one) and that identifiers are unverified.",
      "Submit, then record the CyberTipline report number on the case (Mark reported). That starts the one-year preservation clock.",
      "Do not contact the user, do not delete anything, and do not discuss the case outside the reviewer group.",
      "If the transcript suggests a real child is in imminent danger, also call 911 / local police and NCMEC (1-800-843-5678).",
    ],
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

export function renderReportHtml(p: ReportPackage): string {
  const row = (k: string, v: string | null | undefined) => `<tr><th>${esc(k)}</th><td>${esc(v ?? "—")}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>CyberTipline package ${esc(p.internal.caseId)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
th{text-align:left;vertical-align:top;padding:4px 12px 4px 0;white-space:nowrap}td{padding:4px 0}pre{white-space:pre-wrap;background:#f4f4f4;padding:12px}
.notice{border:2px solid #b00;padding:8px 12px}</style></head><body>
<p class="notice">${esc(p.notice)}</p>
<h1>CyberTipline report package</h1>
<h2>Reporting ESP</h2><table>${row("ESP", p.reportingEsp.espName)}${row("Contact", p.reportingEsp.espContactName)}${row("Email", p.reportingEsp.espContactEmail)}${row("Service", `${p.reportingEsp.service} — ${p.reportingEsp.serviceUrl}`)}</table>
<h2>Incident</h2><table>${row("Type", p.incidentSummary.incidentType)}${row("Date/time (UTC)", p.incidentSummary.incidentDateTime)}${row("Description", p.incidentSummary.incidentDescription)}${row("Detection", p.incidentSummary.detectionMethod)}</table>
<h2>Reported person</h2><table>${p.reportedPerson.ipAddresses.map((i) => row(`IP (${i.event})`, `${i.ip} at ${i.capturedAt}`)).join("")}${row("User agent", p.reportedPerson.userAgent)}${p.reportedPerson.identifiers.filter((i) => i.kind !== "ip").map((i) => row(i.kind, i.value)).join("")}${p.reportedPerson.identifiers.filter((i) => i.includedBy).map((i) => row(`Included by ${i.includedBy}`, `${i.kind}:${i.value} — ${i.includedReason ?? ""}`)).join("")}${p.reportedPerson.claimedUnverified.map((i) => row(`${i.kind} (claimed, unverified)`, i.value)).join("")}</table>
<h2>Content</h2><table>${row("SHA-256", p.content.sha256)}${row("Location", p.content.locationOnService)}${row("Viewed by ESP", "Yes")}${row("Publicly available", "No")}</table>
<h3>Flagged text</h3><pre>${esc(p.content.text)}</pre>
<h3>Context (oldest first)</h3><pre>${esc(p.content.contextTranscript.map((t) => `[${t.at ?? ""}] ${t.speaker}: ${t.content}`).join("\n"))}</pre>
<h2>Classifier</h2><pre>${esc(JSON.stringify(p.classifier, null, 2))}</pre>
<h2>Internal</h2><pre>${esc(JSON.stringify(p.internal, null, 2))}</pre>
<h2>Filing checklist</h2><ol>${p.checklist.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>
</body></html>`;
}
