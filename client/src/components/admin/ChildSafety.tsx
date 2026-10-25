import { useState, useEffect, useCallback } from "react";

/**
 * Child-safety review queue. Lists evidence cases by metadata only; the
 * content is fetched only when a reviewer clicks "View evidence", and every
 * call (list, view, dismiss, confirm, report) is written to the server's
 * access log under the reviewer name entered here.
 *
 * Nothing here files with NCMEC. "Report package" opens a CyberTipline-ready
 * document for a human to file; "Mark reported" records the report number.
 * See docs/child-safety.md.
 */

const BASE = import.meta.env.BASE_URL + "api/admin/child-safety";

interface Ident {
  kind: string;
  value: string;
  role?: "flagged" | "participant";
  verified?: boolean;
  slot?: string | null;
  includedBy?: string;
  includedReason?: string;
}

interface CaseSummary {
  id: string;
  source: string;
  status: "open" | "dismissed" | "confirmed" | "reported" | "released";
  categories: string[];
  gameRef: string | null;
  ipAddress: string | null;
  identifiers: Ident[];
  incidentAt: number;
  createdAt: number;
  isTest: boolean;
  locked: boolean;
  retainUntil: number | null;
  purgeAfter: number | null;
  dismissReason: string | null;
  cybertipReportId: string | null;
  encrypted: boolean;
  groupRef?: string | null;
  recordKind?: "flag" | "suppressed_burst" | null;
}

interface Evidence {
  content: string;
  contentSha256: string;
  context: Array<{ speaker: string; content: string; label?: string | null }>;
  categories: string[];
  scores: Record<string, number> | null;
  model: string | null;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  sender?: string | null;
  ipHistory: Array<{ ip: string; event: string; at: number; slot?: string | null }>;
  extra?: {
    suppressedBurst?: {
      key: { kind: string; value: string }; count: number; firstAt: number; lastAt: number; sha256: string[];
      samples?: Array<{ incidentAt: number; content: string; contentSha256: string; claimedSha256?: string | null; truncated?: boolean; originalLength?: number; ipAddress: string | null; userAgent: string | null; gameRef: string | null; identifiers: Ident[] }>;
    };
    contentTruncated?: { originalSha256: string; originalLength: number };
  };
}

const STATUS_FILTERS = ["open", "confirmed", "reported", "dismissed", "released"] as const;

function fmt(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : "—";
}

export function ChildSafety({ token }: { token: string }) {
  const [reviewer, setReviewer] = useState<string>(() => sessionStorage.getItem("cs_reviewer") ?? "");
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("open");
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewing, setViewing] = useState<{ id: string; case: CaseSummary; evidence: Evidence } | null>(null);
  // Related cases from one sending service share a group; click one to see them together.
  const [group, setGroup] = useState<string | null>(null);

  const call = useCallback(
    async (path: string, method = "GET", body?: unknown) => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "X-Reviewer": reviewer, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed: ${res.status}`);
      return json;
    },
    [token, reviewer],
  );

  const load = useCallback(() => {
    if (!reviewer.trim()) return;
    setLoading(true);
    setError(null);
    call(`/cases?status=${status}`)
      .then((r) => setCases((r as { cases: CaseSummary[] }).cases))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [call, status, reviewer]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function view(id: string) {
    if (!window.confirm("Viewing decrypts the evidence and is logged under your name. Continue?")) return;
    await act(async () => {
      const r = (await call(`/cases/${id}/view`, "POST")) as { case: CaseSummary; evidence: Evidence };
      setViewing({ id, case: r.case, evidence: r.evidence });
    });
  }

  async function dismiss(id: string) {
    const reason = window.prompt("Why is this a false positive? (required; evidence is purged 90 days after dismissal)");
    if (!reason?.trim()) return;
    await act(() => call(`/cases/${id}/dismiss`, "POST", { reason }));
    if (viewing?.id === id) setViewing(null);
  }

  async function confirm(id: string) {
    if (!window.confirm("Confirm as reportable? This locks the evidence (1-year minimum hold) and bans the flagged sender's IPs. Other participants are not banned unless you include them.")) return;
    await act(() => call(`/cases/${id}/confirm`, "POST"));
  }

  // Legacy rows have no role: only the case's own request IP counts as the sender's.
  const roleOf = (c: CaseSummary, i: Ident) => i.role ?? (i.kind === "ip" && i.value === c.ipAddress ? "flagged" : "participant");
  const verifiedOf = (i: Ident) => i.verified ?? i.kind === "ip";

  async function includeParticipant(c: CaseSummary, i: Ident) {
    const reason = window.prompt(
      `Include ${i.kind} ${i.value} (another participant) in the bans and the report? This is logged. Reason (required):`,
    );
    if (!reason?.trim()) return;
    await act(async () => {
      const updated = (await call(`/cases/${c.id}/include-participant`, "POST", { kind: i.kind, value: i.value, reason })) as CaseSummary;
      setViewing((v) => (v && v.id === c.id ? { ...v, case: updated } : v));
    });
  }

  async function reportPackage(id: string) {
    await act(async () => {
      const res = await fetch(`${BASE}/cases/${id}/report?format=html`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "X-Reviewer": reviewer },
      });
      if (!res.ok) throw new Error(`Report failed: ${res.status}`);
      const url = URL.createObjectURL(new Blob([await res.text()], { type: "text/html" }));
      window.open(url, "_blank", "noopener");
    });
  }

  async function markReported(id: string) {
    const rid = window.prompt("CyberTipline report number:");
    if (!rid?.trim()) return;
    await act(() => call(`/cases/${id}/reported`, "POST", { cybertipReportId: rid }));
  }

  if (!reviewer.trim()) {
    return (
      <div className="admin-login">
        <h2>Reviewer</h2>
        <p style={{ color: "#888", fontSize: 13 }}>Every action here is logged under your name.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = (new FormData(e.currentTarget).get("name") as string).trim();
            if (v) {
              sessionStorage.setItem("cs_reviewer", v);
              setReviewer(v);
            }
          }}
        >
          <input name="name" placeholder="Your name" autoFocus />
          <button type="submit">Continue</button>
        </form>
      </div>
    );
  }

  return (
    <div>
      <p style={{ color: "#888", fontSize: 13, margin: "0.5rem 0 1rem" }}>
        Child-safety evidence cases (reviewer: {reviewer}). Content is shown only on "View evidence".
        Nothing is filed automatically: confirmed cases get a report package for a human to file at
        report.cybertip.org.
      </p>
      <div className="admin-filters">
        <label>
          Status{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value as (typeof STATUS_FILTERS)[number])}>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      {error && <div className="loading">Error: {error}</div>}
      {loading && <div className="loading">Loading…</div>}
      <table className="admin-table" style={{ margin: "1rem 0" }}>
        <thead>
          <tr>
            <th>Incident</th>
            <th>Source</th>
            <th>Categories</th>
            <th>IP</th>
            <th>Hold</th>
            <th>Group</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {cases.length === 0 ? (
            <tr>
              <td colSpan={7} style={{ color: "#555", fontStyle: "italic" }}>No {status} cases</td>
            </tr>
          ) : (
            cases.filter((c) => !group || c.groupRef === group).map((c) => (
              <tr key={c.id}>
                <td title={c.id}>{fmt(c.incidentAt)}{c.isTest && <span style={{ color: "#fc6", marginLeft: 6 }}>test</span>}</td>
                <td>{c.source}{c.recordKind === "suppressed_burst" && <span style={{ color: "#fc6", marginLeft: 6 }}>suppressed burst</span>}</td>
                <td>{c.categories.join(", ")}</td>
                <td style={{ fontFamily: "monospace", fontSize: 12 }}>{c.ipAddress ?? "—"}</td>
                <td style={{ fontSize: 12 }}>
                  {c.locked ? `locked until ${fmt(c.retainUntil)}` : c.purgeAfter ? `purge ${fmt(c.purgeAfter)}` : "kept while open"}
                  {c.cybertipReportId && <div>CT #{c.cybertipReportId}</div>}
                </td>
                <td style={{ fontFamily: "monospace", fontSize: 12 }}>
                  {c.groupRef ? <button title={c.groupRef} onClick={() => setGroup(group === c.groupRef ? null : c.groupRef!)}>{group === c.groupRef ? "all" : c.groupRef.slice(0, 10)}</button> : "—"}
                </td>
                <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button onClick={() => view(c.id)}>View evidence</button>
                  {c.status === "open" && <button onClick={() => dismiss(c.id)}>Dismiss</button>}
                  {(c.status === "open" || c.status === "dismissed") && (
                    <button style={{ color: "#ff6b6b" }} onClick={() => confirm(c.id)}>Confirm &amp; report</button>
                  )}
                  {(c.status === "confirmed" || c.status === "reported") && (
                    <button onClick={() => reportPackage(c.id)}>Report package</button>
                  )}
                  {c.status === "confirmed" && <button onClick={() => markReported(c.id)}>Mark reported</button>}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {viewing && (
        <div className="detail-section">
          <h3>Evidence {viewing.id} <button onClick={() => setViewing(null)}>Close</button></h3>
          <p>SHA-256: <code>{viewing.evidence.contentSha256}</code></p>
          <p>Classifier: {viewing.evidence.model ?? "—"} · {viewing.evidence.categories.join(", ")}</p>
          {viewing.evidence.reason && <p>Reason: {viewing.evidence.reason}</p>}
          <p>User agent: {viewing.evidence.userAgent ?? "—"}</p>
          <h4>Flagged sender{viewing.evidence.sender ? ` (${viewing.evidence.sender})` : ""}: banned on confirm, in the report</h4>
          <ul>
            {viewing.case.identifiers.filter((i) => roleOf(viewing.case, i) === "flagged").map((i) => (
              <li key={`${i.kind}:${i.value}`}>
                {i.kind}: <code>{i.value}</code>
                {!verifiedOf(i) && <em> (claimed, unverified: never banned)</em>}
                {i.includedBy && <em> (included by {i.includedBy}: {i.includedReason})</em>}
              </li>
            ))}
          </ul>
          <h4>Other participants: not banned, not in the report</h4>
          <ul>
            {viewing.case.identifiers.filter((i) => roleOf(viewing.case, i) === "participant").map((i) => (
              <li key={`${i.kind}:${i.value}`}>
                {i.kind}: <code>{i.value}</code>{i.slot ? ` (${i.slot})` : ""}
                {verifiedOf(i) ? (
                  <button style={{ marginLeft: 8 }} onClick={() => includeParticipant(viewing.case, i)}>Include…</button>
                ) : (
                  <em> (claimed, unverified)</em>
                )}
              </li>
            ))}
          </ul>
          {viewing.evidence.extra?.suppressedBurst && (
            <>
              <h4>Suppressed burst</h4>
              <p>
                {viewing.evidence.extra.suppressedBurst.count} flags from {viewing.evidence.extra.suppressedBurst.key.kind}{" "}
                <code>{viewing.evidence.extra.suppressedBurst.key.value}</code> between {fmt(viewing.evidence.extra.suppressedBurst.firstAt)} and{" "}
                {fmt(viewing.evidence.extra.suppressedBurst.lastAt)}, over the sending service's case cap. {viewing.evidence.extra.suppressedBurst.samples?.length ?? 0} kept in full below, each with its own sender; {viewing.evidence.extra.suppressedBurst.sha256.length} SHA-256 hashes in the content.
              </p>
              {(viewing.evidence.extra.suppressedBurst.samples ?? []).map((smp, k) => (
                <div key={k} style={{ borderLeft: "3px solid #fc6", paddingLeft: 8, margin: "8px 0" }}>
                  <div>Sample {k + 1} · {fmt(smp.incidentAt)} · IP <code>{smp.ipAddress ?? "—"}</code> · game <code>{smp.gameRef ?? "—"}</code></div>
                  <div>UA: {smp.userAgent ?? "—"}</div>
                  <div style={{ fontSize: 12 }}>
                    Left out of the report package unless added:{" "}
                    {(["ipAddress", "userAgent"] as const).map((field) => (
                      <button key={field} style={{ marginLeft: 6 }} onClick={async () => {
                        const reason = window.prompt(`Why add this sample's ${field === "ipAddress" ? "IP" : "user agent"} to the report? (required, logged)`);
                        if (!reason?.trim()) return;
                        await act(() => call(`/cases/${viewing.id}/include-sample-detail`, "POST", { sample: k, field, reason }));
                      }}>Add {field === "ipAddress" ? "IP" : "user agent"}…</button>
                    ))}
                  </div>
                  <ul>
                    {smp.identifiers.map((i) => (
                      <li key={`${i.kind}:${i.value}`}>{i.kind}: <code>{i.value}</code>{i.role ? " (participant)" : ""}{!i.verified && <em> (claimed, unverified)</em>}</li>
                    ))}
                  </ul>
                  <div>SHA-256 (computed here) <code>{smp.contentSha256}</code>{smp.truncated ? ` · truncated from ${smp.originalLength} characters` : ""}{smp.claimedSha256 && smp.claimedSha256 !== smp.contentSha256 ? <> · sender's hash (unverified) <code>{smp.claimedSha256}</code></> : null}</div>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{smp.content}</pre>
                </div>
              ))}
            </>
          )}
          {viewing.evidence.extra?.contentTruncated && (
            <p>
              The sender capped this flag at the ingest limit. Original: {viewing.evidence.extra.contentTruncated.originalLength} characters, SHA-256{" "}
              <code>{viewing.evidence.extra.contentTruncated.originalSha256}</code>; the full text is kept in the sending service's outbox for manual retrieval.
            </p>
          )}
          <h4>Flagged content</h4>
          <pre style={{ whiteSpace: "pre-wrap" }}>{viewing.evidence.content}</pre>
          <h4>Context (oldest first)</h4>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {viewing.evidence.context.map((t) => `${t.speaker}: ${t.content}`).join("\n")}
          </pre>
          <h4>IP log</h4>
          <pre>{viewing.evidence.ipHistory.map((h) => `${new Date(h.at).toISOString()} ${h.event} ${h.slot ?? "?"} ${h.ip}`).join("\n") || "—"}</pre>
        </div>
      )}
    </div>
  );
}
