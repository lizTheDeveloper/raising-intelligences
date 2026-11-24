import { useCallback, useEffect, useState } from "react";
import { lowerLevel } from "../../meetupCard";

/**
 * Meetup host tools, prototype admin (spec build plan B.3). People (hosts and
 * guest readers), events, and reports about hosts. An event's code is derived
 * from the server's pepper and the event id, so it can be shown again ("link")
 * and replaced ("new link", the old one stops at once); only its hash is
 * stored. Events from before 2.17.0 have no derivable code until replaced.
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
  hostType: HostType | null;
  organisation: string | null;
  /** The host terms they agreed to: null until they agree (in their portal, or on paper, recorded here). */
  agreementVersion: string | null;
  agreementAt: number | null;
}

/** An onboarding invite (persona tests, S2-5). Its token was shown once, when it was made. */
interface Invite {
  id: string;
  displayName: string;
  hostType: HostType;
  organisation: string | null;
  createdAt: number;
  expiresAt: number;
  status: "open" | "used" | "expired" | "revoked";
  personName: string | null;
}

/** §9.1, on the person (set once). Every event's levels and naming come from it. */
type HostType = "club" | "authority" | "events_business" | "sensitive" | "studio";
const HOST_TYPE_LABEL: Record<HostType, string> = {
  club: "club or group (no authority over attendees): host at L0, L1 or L3",
  authority: "has authority over attendees (teacher, employer…): host at L0 or L1, never share codes",
  events_business: "dating or events business: can't host; can promote a studio event, unnamed, handle exchange off",
  sensitive: "faith or sensitive-community counsellor: can't host; guest reader at a studio event",
  studio: "studio staff: guest reader at a studio event",
};
const HOST_TYPE_SHORT: Record<HostType, string> = {
  club: "club", authority: "authority", events_business: "events business", sensitive: "sensitive", studio: "studio",
};

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
  promoterIds?: string[];
  handleExchange: boolean;
  studioLearning: boolean;
}

interface HostReport { id: string; eventId: string | null; text: string; at: number; status: "open" | "done" }
interface UnlinkRequest { id: string; at: number; doneAt: number | null; event: string | null }

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
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteMade, setInviteMade] = useState<{ name: string; link: string } | null>(null);
  const [events, setEvents] = useState<HostEventRow[]>([]);
  const [reports, setReports] = useState<HostReport[]>([]);
  const [unlinks, setUnlinks] = useState<UnlinkRequest[]>([]);
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [purged, setPurged] = useState<{ at: number; deleted: Record<string, number> } | null>(null);
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
      const [s, p, e, r, u, a, i] = await Promise.all([
        api<Status>("/status"),
        api<{ people: Person[] }>("/hosts"),
        api<{ events: HostEventRow[] }>("/events"),
        api<{ reports: HostReport[] }>("/host-reports"),
        api<{ requests: UnlinkRequest[] }>("/unlink-requests"),
        api<{ games: string[] }>("/analysis-allowlist"),
        api<{ invites: Invite[] }>("/invites"),
      ]);
      setInvites(i.invites);
      setStatus(s);
      setPeople(p.people);
      setEvents(e.events);
      setReports(r.reports);
      setUnlinks(u.requests);
      setAllowlist(a.games);
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
  const [pType, setPType] = useState<HostType | "">("");
  const [pOrg, setPOrg] = useState("");
  const [pSigned, setPSigned] = useState(false);
  const [pSignedVersion, setPSignedVersion] = useState("");
  const createPerson = (e: React.FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await api("/hosts", "POST", {
        matrixId: pMxid.trim(),
        displayName: pName.trim(),
        hostType: pType,
        ...(pOrg.trim() ? { organisation: pOrg.trim() } : {}),
        ...(pRole.trim() ? { roleText: pRole.trim() } : {}),
        ...(pChecked.trim() ? { roleChecked: pChecked.trim() } : {}),
        ...(pSigned ? { agreementSigned: true, ...(pSignedVersion.trim() ? { agreementVersion: pSignedVersion.trim() } : {}) } : {}),
      });
      setPMxid(""); setPName(""); setPRole(""); setPChecked(""); setPType(""); setPOrg(""); setPSigned(false); setPSignedVersion("");
    });
  };

  // ---- invites ----
  const [iName, setIName] = useState("");
  const [iType, setIType] = useState<HostType | "">("");
  const [iOrg, setIOrg] = useState("");
  const createInvite = (e: React.FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const r = await api<{ link: string; invite: { displayName: string } }>("/invites", "POST", {
        displayName: iName.trim(),
        hostType: iType,
        ...(iOrg.trim() ? { organisation: iOrg.trim() } : {}),
      });
      setInviteMade({ name: r.invite.displayName, link: r.link });
      setIName(""); setIType(""); setIOrg("");
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
    promoterIds: [] as string[],
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
        ...(ev.promoterIds.length ? { promoterIds: ev.promoterIds } : {}),
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
  const setType = (p: Person, t: HostType) => {
    if (!window.confirm(`Set ${p.displayName} as: ${HOST_TYPE_LABEL[t]}? This is set once.`)) return;
    void act(() => api(`/hosts/${p.id}/type`, "POST", { hostType: t }));
  };
  const personName = (id: string | null) => (id ? people.find((p) => p.id === id)?.displayName ?? id.slice(0, 8) : "—");
  const approved = people.filter((p) => p.status === "approved");
  const openReports = reports.filter((r) => r.status === "open");
  const openUnlinks = unlinks.filter((u) => u.doneAt === null);
  /** A 404 means someone already did it: the list is read again and the server's words shown. */
  const markUnlinkDone = (id: string) =>
    act(async () => {
      try {
        await api(`/unlink-requests/${id}/done`, "POST");
      } catch (err) {
        await load();
        throw err;
      }
    });
  const runPurge = () => {
    if (!window.confirm("Run the purge now? Rows past their retention are deleted for good.")) return;
    void act(async () => {
      const r = await api<{ deleted: Record<string, number> }>("/purge", "POST");
      setPurged({ at: Date.now(), deleted: r.deleted });
    });
  };

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
          <h3>Meetup link: {created.name}</h3>
          <p style={{ fontSize: 28, letterSpacing: 2, margin: "8px 0", wordBreak: "break-all" }}><code>{created.code}</code></p>
          <p style={{ wordBreak: "break-all" }}>
            <a href={created.link} target="_blank" rel="noopener noreferrer">{created.link}</a>{" "}
            <button onClick={() => void navigator.clipboard?.writeText(created.link)}>copy link</button>
          </p>
          <p>The server keeps only a hash of this code. You (and the event's host, in their portal) can see it again with "link"; "new link" replaces it.</p>
          <button onClick={() => setCreated(null)}>done</button>
        </div>
      )}

      <div className="detail-section">
        <h3>People (hosts and guest readers)</h3>
        <table className="admin-table">
          <thead><tr><th>Name</th><th>Type</th><th>Role</th><th>Role checked</th><th>Host terms</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {people.length === 0 && <tr><td colSpan={7} className="dim">No one yet.</td></tr>}
            {people.map((p) => (
              <tr key={p.id}>
                <td>{p.displayName}{p.organisation && !p.displayName.includes(p.organisation) ? <span className="dim"> ({p.organisation})</span> : null}</td>
                <td title={p.hostType ? HOST_TYPE_LABEL[p.hostType] : undefined}>
                  {p.hostType ? HOST_TYPE_SHORT[p.hostType] : (
                    <select aria-label={`set ${p.displayName}'s host type`} value="" disabled={busy} onChange={(e) => e.target.value && setType(p, e.target.value as HostType)}>
                      <option value="">set type…</option>
                      {(Object.keys(HOST_TYPE_LABEL) as HostType[]).map((t) => <option key={t} value={t}>{HOST_TYPE_LABEL[t]}</option>)}
                    </select>
                  )}
                </td>
                <td>{p.roleText ?? "—"}</td>
                <td>{p.roleChecked ? `${p.roleChecked} (${when(p.roleCheckedAt)})` : "—"}</td>
                <td>{p.agreementAt ? `${p.agreementVersion ?? "?"} (${when(p.agreementAt)})` : <span className="dim">not yet: asked in their portal</span>}</td>
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
          <label>Host type (set once){" "}
            <select required value={pType} onChange={(e) => setPType(e.target.value as HostType | "")}>
              <option value="">(choose)</option>
              {(Object.keys(HOST_TYPE_LABEL) as HostType[]).map((t) => <option key={t} value={t}>{HOST_TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          <label>Business or group name (optional, never shown to players) <input maxLength={60} placeholder="e.g. Spark Night" value={pOrg} onChange={(e) => setPOrg(e.target.value)} /></label>
          <label><input type="checkbox" checked={pSigned} onChange={(e) => setPSigned(e.target.checked)} /> They signed a host agreement with the studio</label>
          {pSigned && <label>Which agreement (optional) <input maxLength={60} placeholder="e.g. paper-2026-11" value={pSignedVersion} onChange={(e) => setPSignedVersion(e.target.value)} /></label>}
          <button type="submit" disabled={busy}>Add person</button>
        </form>
        <p className="dim" style={{ fontSize: 12 }}>Most people should get an invite instead (below): it takes them through sign-in, the 18+ check and the host terms. Adding someone here needs them to have passed the 18+ check already. Unless you tick the signed-agreement box, their portal asks them to agree to the host terms before it opens. Only a hash of the Matrix id is stored. A person added before host types shows "set type…": they can't go on a new event until it's set.</p>
      </div>

      <div className="detail-section">
        <h3>Invites (hosts and guest readers)</h3>
        {inviteMade && (
          <div style={{ border: "2px solid #e8b96a", padding: 16, margin: "8px 0" }} role="status" data-testid="invite-made">
            <p>Invite for <strong>{inviteMade.name}</strong>. Send them this link. It works once, for 14 days, and isn't shown again.</p>
            <p style={{ wordBreak: "break-all" }}>
              <code>{inviteMade.link}</code>{" "}
              <button onClick={() => void navigator.clipboard?.writeText(inviteMade.link)}>copy link</button>
            </p>
            <button onClick={() => setInviteMade(null)}>done</button>
          </div>
        )}
        <table className="admin-table">
          <thead><tr><th>For</th><th>Type</th><th>Made</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {invites.length === 0 && <tr><td colSpan={5} className="dim">No invites yet.</td></tr>}
            {invites.map((i) => (
              <tr key={i.id}>
                <td>{i.displayName}{i.organisation ? <span className="dim"> ({i.organisation})</span> : null}</td>
                <td>{HOST_TYPE_SHORT[i.hostType]}</td>
                <td>{when(i.createdAt)}</td>
                <td>{i.status === "used" ? `used${i.personName ? ` by ${i.personName}` : ""}` : i.status === "open" ? `open until ${when(i.expiresAt)}` : i.status}</td>
                <td>{i.status === "open" && <button disabled={busy} onClick={() => { if (window.confirm(`Revoke the invite for ${i.displayName}?`)) void act(() => api(`/invites/${i.id}/revoke`, "POST", {})); }}>revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form onSubmit={createInvite} className="admin-filters" style={{ flexWrap: "wrap", marginTop: 12 }}>
          <label>Their name, as they'll see it <input required maxLength={60} value={iName} onChange={(e) => setIName(e.target.value)} /></label>
          <label>Host type (set once){" "}
            <select required value={iType} onChange={(e) => setIType(e.target.value as HostType | "")}>
              <option value="">(choose)</option>
              {(Object.keys(HOST_TYPE_LABEL) as HostType[]).map((t) => <option key={t} value={t}>{HOST_TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          <label>Business or group name (optional, never shown to players) <input maxLength={60} value={iOrg} onChange={(e) => setIOrg(e.target.value)} /></label>
          <button type="submit" disabled={busy}>Make invite</button>
        </form>
        <p className="dim" style={{ fontSize: 12 }}>The link takes them through sign-in, the 18+ check (the same as players', with copy for hosts) and the host terms. What they agree to is what's recorded. Then their portal opens. Add them to an event as host or guest reader afterwards.</p>
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
                  <td>
                    {e.kind === "outside" ? personName(e.hostPersonId) : e.guestReaderId ? `guest: ${personName(e.guestReaderId)}` : "studio"}
                    {e.promoterIds && e.promoterIds.length > 0 && <div className="dim">promoted by {e.promoterIds.map((id) => personName(id)).join(", ")}</div>}
                  </td>
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
                    {!closed && (
                      <button disabled={busy} onClick={() => void act(async () => {
                        const r = await api<{ code: string | null }>(`/events/${e.id}/link`);
                        if (!r.code) throw new Error(`"${e.name}" was made before links could be shown again. Use "new link" to get one.`);
                        setCreated({ name: e.name, code: r.code, link: `${location.origin}${import.meta.env.BASE_URL}?meetup=${encodeURIComponent(r.code)}` });
                      })}>link</button>
                    )}
                    {!closed && (
                      <button disabled={busy} onClick={() => {
                        if (!window.confirm(`New link for "${e.name}"? The old link stops working at once; anyone still reading the card needs the new one. People already waiting or playing carry on.`)) return;
                        void act(async () => {
                          const r = await api<{ code: string }>(`/events/${e.id}/new-link`, "POST", {});
                          setCreated({ name: e.name, code: r.code, link: `${location.origin}${import.meta.env.BASE_URL}?meetup=${encodeURIComponent(r.code)}` });
                        });
                      }}>new link</button>
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
          <fieldset style={{ border: "1px solid #444", padding: 8 }}>
            <legend>Promoted by (they can't play at this meetup and see nothing)</legend>
            {approved.length === 0 && <span className="dim">No one yet.</span>}
            {approved.filter((p) => p.id !== ev.hostPersonId && p.id !== ev.guestReaderId).map((p) => (
              <label key={p.id} style={{ display: "block" }}>
                <input
                  type="checkbox"
                  checked={ev.promoterIds.includes(p.id)}
                  onChange={(e) => setF("promoterIds", e.target.checked ? [...ev.promoterIds, p.id] : ev.promoterIds.filter((x) => x !== p.id))}
                />{" "}
                {p.displayName}{p.hostType ? ` (${HOST_TYPE_SHORT[p.hostType]})` : ""}
              </label>
            ))}
          </fieldset>
          <p className="dim" style={{ fontSize: 12, margin: 0 }}>
            The ceilings come from each person's host type: a host with authority gets L1 at most, an events business never hosts and turns the handle exchange off when it promotes, and its name can't be in the event's name or welcome. The boxes below can only add to that.
          </p>
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

      <div className="detail-section">
        <h3>Unlink requests ({openUnlinks.length} open)</h3>
        <p className="dim" style={{ fontSize: 12 }}>"Take this game off my account". The code was voided when they asked; "done" unlinks them (spec §6).</p>
        <table className="admin-table">
          <thead><tr><th>Asked</th><th>Event</th><th>Done</th><th></th></tr></thead>
          <tbody>
            {unlinks.length === 0 && <tr><td colSpan={4} className="dim">No requests.</td></tr>}
            {unlinks.map((u) => (
              <tr key={u.id}>
                <td style={{ whiteSpace: "nowrap" }}>{when(u.at)}</td>
                <td>{u.event ?? "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>{u.doneAt === null ? "—" : when(u.doneAt)}</td>
                <td>
                  {u.doneAt === null && (
                    <button disabled={busy} onClick={() => { if (window.confirm("Unlink this player from the game now? This can't be undone.")) void markUnlinkDone(u.id); }}>done</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="detail-section">
        <h3>Purge</h3>
        <p className="dim" style={{ fontSize: 12 }}>Runs the retention schedule (spec §10). Only counts of deleted rows come back.</p>
        <button disabled={busy} onClick={runPurge}>run purge</button>
        {purged && (
          <div role="status" style={{ marginTop: 8 }}>
            <p>Purged at {when(purged.at)}:</p>
            {Object.keys(purged.deleted).length === 0 ? (
              <p className="dim">Nothing to delete.</p>
            ) : (
              <table className="admin-table">
                <thead><tr><th>Table</th><th>Rows deleted</th></tr></thead>
                <tbody>
                  {Object.entries(purged.deleted).map(([table, n]) => (
                    <tr key={table}><td><code>{table}</code></td><td>{n}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      <div className="detail-section">
        <h3>Analysis allow-list ({allowlist.length} {allowlist.length === 1 ? "game" : "games"})</h3>
        <p className="dim" style={{ fontSize: 12 }}>Studio-event games where both parents said yes to studio learning (H18). Model-search and internal review only, never ri-devlog: no meetup game ever goes in a blog post, allow-listed or not. Model-search sends these prompts only to providers that don't store or train on them (OpenRouter data_collection: deny).</p>
        {allowlist.length === 0 ? (
          <p className="dim">None.</p>
        ) : (
          <ul>
            {allowlist.map((id) => <li key={id}><code>{id}</code></li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
