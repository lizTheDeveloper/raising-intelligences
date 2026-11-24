import { useCallback, useEffect, useState } from "react";
import { lowerLevel } from "../../meetupCard";

/**
 * Meetup host tools, prototype admin (spec build plan B.3). People (hosts and
 * guest readers), events, and reports about hosts. An event's code is shown
 * once, when it is created, and never again: the server keeps only its hash.
 * Server errors are shown as the server words them.
 */

const BASE = import.meta.env.BASE_URL + "api/admin/host-tools";

interface Status {
  active: boolean;
  shareCodeSecret: boolean;
  traceRetentionDays: number | null;
  traceWhere: string;
  paywallOn: boolean;
}

interface Person {
  id: string;
  displayName: string;
  roleText: string | null;
  roleChecked: string | null;
  roleCheckedAt: number | null;
  status: "approved" | "suspended" | "closed";
  createdAt?: number;
}

interface HostEventRow {
  id: string;
  name: string;
  kind: "studio" | "outside";
  level: number;
  status: string;
  joined: number;
  paused: boolean;
  closedAt: number | null;
  cardVersion: number;
  firstAckAt: number | null;
  opensAt: number;
  closesAt: number;
  capacity: number;
  hostPersonId: string | null;
  guestReaderId: string | null;
  handleExchange: boolean;
  studioLearning: boolean;
}

interface HostReport { id: string; eventId: string | null; text: string; at: number; status: "open" | "done" }

const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : "—");

/** datetime-local value (local time) → epoch ms; NaN when empty or invalid. */
function localToMs(v: string): number {
  return v ? new Date(v).getTime() : NaN;
}
function msToLocal(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export function HostTools({ token }: { token: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [events, setEvents] = useState<HostEventRow[]>([]);
  const [reports, setReports] = useState<HostReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; code: string; link: string } | null>(null);

  const api = useCallback(async <T,>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `Request failed: ${res.status}`);
    return json;
  }, [token]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, p, e, r] = await Promise.all([
        api<Status>("/status"),
        api<{ people: Person[] }>("/hosts"),
        api<{ events: HostEventRow[] }>("/events"),
        api<{ reports: HostReport[] }>("/host-reports"),
      ]);
      setStatus(s);
      setPeople(p.people);
      setEvents(e.events);
      setReports(r.reports);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  /** Runs one admin action, shows its error verbatim, then reloads. */
  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // ---- create person ----
  const [pMxid, setPMxid] = useState("");
  const [pName, setPName] = useState("");
  const [pRole, setPRole] = useState("");
  const [pChecked, setPChecked] = useState("");
  const createPerson = (e: React.FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await api("/hosts", "POST", {
        matrixId: pMxid.trim(),
        displayName: pName.trim(),
        ...(pRole.trim() ? { roleText: pRole.trim() } : {}),
        ...(pChecked.trim() ? { roleChecked: pChecked.trim() } : {}),
      });
      setPMxid(""); setPName(""); setPRole(""); setPChecked("");
    });
  };

  // ---- create event ----
  const now = Date.now();
  const [ev, setEv] = useState({
    name: "",
    kind: "studio" as "studio" | "outside",
    level: 0,
    hostPersonId: "",
    guestReaderId: "",
    authority: false,
    eventsBusiness: false,
    sensitive: false,
    handleExchange: true,
    studioLearning: false,
    welcomeText: "",
    lengthText: "",
    conductUrl: "",
    capacity: "100",
    opensAt: msToLocal(now),
    closesAt: msToLocal(now + 4 * 3600_000),
  });
  const setF = <K extends keyof typeof ev>(k: K, v: (typeof ev)[K]) => setEv((prev) => ({ ...prev, [k]: v }));
  const createEvent = (e: React.FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const body = {
        name: ev.name.trim(),
        kind: ev.kind,
        level: ev.level,
        ...(ev.kind === "outside" && ev.hostPersonId ? { hostPersonId: ev.hostPersonId } : {}),
        ...(ev.kind === "studio" && ev.guestReaderId ? { guestReaderId: ev.guestReaderId } : {}),
        authority: ev.authority,
        eventsBusiness: ev.eventsBusiness,
        sensitive: ev.sensitive,
        handleExchange: ev.handleExchange,
        studioLearning: ev.kind === "studio" && ev.studioLearning,
        welcomeText: ev.welcomeText.trim(),
        ...(ev.lengthText.trim() ? { lengthText: ev.lengthText.trim() } : {}),
        ...(ev.conductUrl.trim() ? { conductUrl: ev.conductUrl.trim() } : {}),
        capacity: Number(ev.capacity),
        opensAt: localToMs(ev.opensAt),
        closesAt: localToMs(ev.closesAt),
      };
      const r = await api<{ event: HostEventRow; code: string; link: string }>("/events", "POST", body);
      setCreated({
        name: r.event.name,
        code: r.code,
        link: `${location.origin}${import.meta.env.BASE_URL}?meetup=${encodeURIComponent(r.code)}`,
      });
      setF("name", "");
    });
  };

  const patchEvent = (id: string, patch: Record<string, unknown>) => act(() => api(`/events/${id}`, "PATCH", patch));
  const personName = (id: string | null) => (id ? people.find((p) => p.id === id)?.displayName ?? id.slice(0, 8) : "—");
  const approved = people.filter((p) => p.status === "approved");
  const openReports = reports.filter((r) => r.status === "open");

  return (
    <div>
      <h2>Host tools (prototype)</h2>
      {status ? (
        <div className="status-bar">
          <span>host tools: <span className="val">{status.active ? "on (meetup mode)" : "off"}</span></span>
          <span>share-code secret: <span className="val">{status.shareCodeSecret ? "set" : "not set"}</span></span>
          <span>traces: <span className="val">{status.traceWhere}, {status.traceRetentionDays === null ? "kept until deleted" : `${status.traceRetentionDays} days`}</span></span>
          <span>paywall: <span className="val">{status.paywallOn ? "on" : "off"}</span></span>
        </div>
      ) : (
        <div className="loading">Loading…</div>
      )}
      {error && <div className="loading" role="alert" style={{ color: "#e06c6c" }}>Error: {error}</div>}

      {created && (
        <div className="detail-section" style={{ border: "2px solid #e8b96a", padding: 16, margin: "16px 0" }} role="status">
          <h3>Event created: {created.name}</h3>
          <p style={{ fontSize: 28, letterSpacing: 2, margin: "8px 0", wordBreak: "break-all" }}><code>{created.code}</code></p>
          <p style={{ wordBreak: "break-all" }}>
            <a href={created.link} target="_blank" rel="noopener noreferrer">{created.link}</a>{" "}
            <button onClick={() => void navigator.clipboard?.writeText(created.link)}>copy link</button>
          </p>
          <p><strong>This code won't be shown again.</strong> Copy it now; the server keeps only a hash of it.</p>
          <button onClick={() => setCreated(null)}>I've saved it</button>
        </div>
      )}

      <div className="detail-section">
        <h3>People (hosts and guest readers)</h3>
        <table className="admin-table">
          <thead><tr><th>Name</th><th>Role</th><th>Role checked</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {people.length === 0 && <tr><td colSpan={5} className="dim">No one yet.</td></tr>}
            {people.map((p) => (
              <tr key={p.id}>
                <td>{p.displayName}</td>
                <td>{p.roleText ?? "—"}</td>
                <td>{p.roleChecked ? `${p.roleChecked} (${when(p.roleCheckedAt)})` : "—"}</td>
                <td>{p.status}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {p.status !== "approved" && <button disabled={busy} onClick={() => void act(() => api(`/hosts/${p.id}/status`, "POST", { status: "approved" }))}>approve</button>}
                  {p.status === "approved" && <button disabled={busy} onClick={() => void act(() => api(`/hosts/${p.id}/status`, "POST", { status: "suspended" }))}>suspend</button>}
                  {p.status !== "closed" && <button disabled={busy} onClick={() => { if (window.confirm(`Close ${p.displayName}'s host account?`)) void act(() => api(`/hosts/${p.id}/status`, "POST", { status: "closed" })); }}>close</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form onSubmit={createPerson} className="admin-filters" style={{ flexWrap: "wrap", marginTop: 12 }}>
          <label>Matrix id <input required placeholder="@name:multiversegames.ai" value={pMxid} onChange={(e) => setPMxid(e.target.value)} /></label>
          <label>Display name <input required maxLength={60} value={pName} onChange={(e) => setPName(e.target.value)} /></label>
          <label>Role (optional) <input maxLength={80} placeholder="e.g. family therapist" value={pRole} onChange={(e) => setPRole(e.target.value)} /></label>
          <label>What the studio checked (optional) <input maxLength={300} placeholder="e.g. licence on the state register" value={pChecked} onChange={(e) => setPChecked(e.target.value)} /></label>
          <button type="submit" disabled={busy}>Add person</button>
        </form>
        <p className="dim" style={{ fontSize: 12 }}>They must have passed the 18+ check first (any meetup link, "get ready early"). Only a hash of the Matrix id is stored.</p>
      </div>

      <div className="detail-section">
        <h3>Events</h3>
        <table className="admin-table">
          <thead>
            <tr><th>Name</th><th>Kind</th><th>Level</th><th>Status</th><th>Joined / cap</th><th>Card v</th><th>First ack</th><th>Opens</th><th>Closes</th><th>Host / guest</th><th></th></tr>
          </thead>
          <tbody>
            {events.length === 0 && <tr><td colSpan={11} className="dim">No events yet.</td></tr>}
            {events.map((e) => {
              const lower = lowerLevel(e.kind, e.level);
              const closed = e.closedAt !== null;
              return (
                <tr key={e.id}>
                  <td>{e.name}</td>
                  <td>{e.kind}</td>
                  <td>L{e.level}</td>
                  <td>{e.status}{e.paused && e.status !== "paused" ? " (paused)" : ""}</td>
                  <td>{e.joined} / {e.capacity}</td>
                  <td>{e.cardVersion}</td>
                  <td>{when(e.firstAckAt)}</td>
                  <td>{when(e.opensAt)}</td>
                  <td>{closed ? `closed ${when(e.closedAt)}` : when(e.closesAt)}</td>
                  <td>{e.kind === "outside" ? personName(e.hostPersonId) : e.guestReaderId ? `guest: ${personName(e.guestReaderId)}` : "studio"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {!closed && (e.paused
                      ? <button disabled={busy} onClick={() => void patchEvent(e.id, { paused: false })}>resume</button>
                      : <button disabled={busy} onClick={() => void patchEvent(e.id, { paused: true })}>pause</button>)}
                    {!closed && lower !== null && (
                      <button disabled={busy} onClick={() => { if (window.confirm(`Lower "${e.name}" to L${lower}? Players see a new card.`)) void patchEvent(e.id, { level: lower }); }}>
                        lower to L{lower}
                      </button>
                    )}
                    {!closed && (
                      <button disabled={busy} onClick={() => { if (window.confirm(`Close "${e.name}" now? This can't be undone.`)) void patchEvent(e.id, { closed: true }); }}>close</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="detail-section">
        <h3>New event</h3>
        <form onSubmit={createEvent} style={{ display: "grid", gap: 8, maxWidth: 560 }}>
          <label>Name <input required maxLength={60} value={ev.name} onChange={(e) => setF("name", e.target.value)} /></label>
          <label>Kind{" "}
            <select value={ev.kind} onChange={(e) => setF("kind", e.target.value as "studio" | "outside")}>
              <option value="studio">studio</option>
              <option value="outside">outside host</option>
            </select>
          </label>
          <label>Level{" "}
            <select value={ev.level} onChange={(e) => setF("level", Number(e.target.value))}>
              <option value={0}>L0: host sees nothing</option>
              <option value={1}>L1: rough totals after close</option>
              <option value={3}>L3: share codes</option>
            </select>
          </label>
          {ev.kind === "outside" ? (
            <label>Host{" "}
              <select value={ev.hostPersonId} onChange={(e) => setF("hostPersonId", e.target.value)}>
                <option value="">(choose)</option>
                {approved.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
              </select>
            </label>
          ) : (
            <label>Guest reader (L3 only){" "}
              <select value={ev.guestReaderId} onChange={(e) => setF("guestReaderId", e.target.value)}>
                <option value="">(none)</option>
                {approved.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
              </select>
            </label>
          )}
          <label><input type="checkbox" checked={ev.authority} onChange={(e) => setF("authority", e.target.checked)} /> host has authority over attendees</label>
          <label><input type="checkbox" checked={ev.eventsBusiness} onChange={(e) => setF("eventsBusiness", e.target.checked)} /> promoted by a dating or events business</label>
          <label><input type="checkbox" checked={ev.sensitive} onChange={(e) => setF("sensitive", e.target.checked)} /> sensitive community</label>
          <label><input type="checkbox" checked={ev.handleExchange} onChange={(e) => setF("handleExchange", e.target.checked)} /> handle exchange at the end</label>
          {ev.kind === "studio" && (
            <label><input type="checkbox" checked={ev.studioLearning} onChange={(e) => setF("studioLearning", e.target.checked)} /> ask about studio learning</label>
          )}
          <label>Welcome text <textarea maxLength={600} rows={3} value={ev.welcomeText} onChange={(e) => setF("welcomeText", e.target.value)} style={{ width: "100%" }} /></label>
          <label>Length (e.g. "90 minutes") <input maxLength={60} value={ev.lengthText} onChange={(e) => setF("lengthText", e.target.value)} /></label>
          <label>Code of conduct URL (https) <input type="url" value={ev.conductUrl} onChange={(e) => setF("conductUrl", e.target.value)} /></label>
          <label>Capacity <input type="number" min={1} max={500} value={ev.capacity} onChange={(e) => setF("capacity", e.target.value)} /></label>
          <label>Opens <input type="datetime-local" required value={ev.opensAt} onChange={(e) => setF("opensAt", e.target.value)} /></label>
          <label>Closes <input type="datetime-local" required value={ev.closesAt} onChange={(e) => setF("closesAt", e.target.value)} /></label>
          <button type="submit" disabled={busy}>Create event</button>
        </form>
      </div>

      <div className="detail-section">
        <h3>Reports about hosts ({openReports.length} open)</h3>
        <table className="admin-table">
          <thead><tr><th>When</th><th>Event</th><th>Report</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {reports.length === 0 && <tr><td colSpan={5} className="dim">No reports.</td></tr>}
            {reports.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: "nowrap" }}>{when(r.at)}</td>
                <td>{r.eventId ? events.find((e) => e.id === r.eventId)?.name ?? r.eventId.slice(0, 8) : "—"}</td>
                <td style={{ whiteSpace: "pre-wrap" }}>{r.text}</td>
                <td>{r.status}</td>
                <td>{r.status === "open" && <button disabled={busy} onClick={() => void act(() => api(`/host-reports/${r.id}/done`, "POST"))}>done</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
