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

interface CaseSummary {
  id: string;
  source: string;
  status: "open" | "dismissed" | "confirmed" | "reported" | "released";
  categories: string[];
  gameRef: string | null;
  ipAddress: string | null;
  incidentAt: number;
  createdAt: number;
  isTest: boolean;
  locked: boolean;
  retainUntil: number | null;
  purgeAfter: number | null;
  dismissReason: string | null;
  cybertipReportId: string | null;
  encrypted: boolean;
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
  identifiers: Array<{ kind: string; value: string }>;
  ipHistory: Array<{ ip: string; event: string; at: number }>;
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
  const [viewing, setViewing] = useState<{ id: string; evidence: Evidence } | null>(null);

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
      const r = (await call(`/cases/${id}/view`, "POST")) as { evidence: Evidence };
      setViewing({ id, evidence: r.evidence });
    });
  }

  async function dismiss(id: string) {
    const reason = window.prompt("Why is this a false positive? (required; evidence is purged 90 days after dismissal)");
    if (!reason?.trim()) return;
    await act(() => call(`/cases/${id}/dismiss`, "POST", { reason }));
    if (viewing?.id === id) setViewing(null);
  }

  async function confirm(id: string) {
    if (!window.confirm("Confirm as reportable? This locks the evidence (1-year minimum hold) and bans every linked IP and identifier.")) return;
    await act(() => call(`/cases/${id}/confirm`, "POST"));
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
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {cases.length === 0 ? (
            <tr>
              <td colSpan={6} style={{ color: "#555", fontStyle: "italic" }}>No {status} cases</td>
            </tr>
          ) : (
            cases.map((c) => (
              <tr key={c.id}>
                <td title={c.id}>{fmt(c.incidentAt)}{c.isTest && <span style={{ color: "#fc6", marginLeft: 6 }}>test</span>}</td>
                <td>{c.source}</td>
                <td>{c.categories.join(", ")}</td>
                <td style={{ fontFamily: "monospace", fontSize: 12 }}>{c.ipAddress ?? "—"}</td>
                <td style={{ fontSize: 12 }}>
                  {c.locked ? `locked until ${fmt(c.retainUntil)}` : c.purgeAfter ? `purge ${fmt(c.purgeAfter)}` : "kept while open"}
                  {c.cybertipReportId && <div>CT #{c.cybertipReportId}</div>}
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
          <p>Identifiers: {viewing.evidence.identifiers.map((i) => `${i.kind}:${i.value}`).join(", ") || "—"}</p>
          <h4>Flagged content</h4>
          <pre style={{ whiteSpace: "pre-wrap" }}>{viewing.evidence.content}</pre>
          <h4>Context (oldest first)</h4>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {viewing.evidence.context.map((t) => `${t.speaker}: ${t.content}`).join("\n")}
          </pre>
          <h4>IP log</h4>
          <pre>{viewing.evidence.ipHistory.map((h) => `${new Date(h.at).toISOString()} ${h.event} ${h.ip}`).join("\n") || "—"}</pre>
        </div>
      )}
    </div>
  );
}
