import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HostHarness, ADMIN } from "./helpers/host-tools.js";
import { buildCard, guestBlock, l3Block, notForMeLines, STUDIO_BLOCK } from "../src/hosts/card.js";
import type { HostEvent, HostPerson } from "../src/hosts/types.js";

/**
 * The event card (host tools spec §3): first on ?meetup=, every line true,
 * and the L3 / guest-reader blocks in the round-3 wording (B4).
 */

const DEV = "@dev:multiversegames.ai";
const JENSEN = "@jensen:multiversegames.ai";

function person(over: Partial<HostPerson> = {}): HostPerson {
  return {
    id: "p1", subject: "s", displayName: "Sister Jensen", roleText: null, roleChecked: null, roleCheckedAt: null,
    agreementVersion: "v", agreementAt: 0, status: "approved", createdAt: 0, ...over,
  };
}

describe("the event card", () => {
  let h: HostHarness;
  beforeEach(async () => { h = await new HostHarness().boot(); });
  afterEach(async () => { await h.close(); });

  it("B4: the L3 block says what a host can notice, in the round-3 wording", () => {
    const text = l3Block("Dev").join("\n");
    expect(text).toContain("may notice that no code came from your pair");
    expect(text).toContain("can reflect them");
    expect(text).toContain("might say so in front of your co-parent");
    expect(text).not.toContain("isn't told you were asked");
    expect(text).not.toContain("no list of who played or who made a code");
    expect(l3Block("Dev")).toEqual([
      "Dev only sees your game if **you two** give them a share code. at the end you'll each be asked, on your own, and you'll see exactly what it shows first. if you both say yes, a code appears on your account page, and you decide whether and when to give it to Dev.",
      "RI never gives Dev a list of who played or who made a code. but Dev may know you came, and may notice that no code came from your pair. they can't tell why. games end up without a code when they don't finish, when either of you says no or waits, when you keep the code to yourselves, or for reasons RI doesn't share.",
      "a code shows: your report card (without its quotes) and your child's epilogue. both were written from your whole game, including your private talks with your child. they don't show those talks, but they can reflect them. you'll read exactly what Dev would see before you choose.",
      "if you both say yes but no code appears, your game couldn't make one. RI doesn't say why.",
      "you can stop a code from your account page at any time. that stops Dev opening it again; it can't make Dev forget what they've already read. if you stop it, Dev will see that it no longer opens, and might say so in front of your co-parent.",
    ]);
  });

  it("B4: the guest-reader block is the studio block, the guest paragraph, then the L3 block", () => {
    const g = guestBlock(person());
    expect(g[0]).toBe(STUDIO_BLOCK);
    expect(g[1]).toBe("Sister Jensen is a guest at this meetup. if you both want to talk your game through with Sister Jensen, you can make a share code for Sister Jensen. Sister Jensen sees nothing else about this meetup.");
    expect(g.slice(2)).toEqual(l3Block("Sister Jensen"));
    const all = g.join("\n");
    expect(all).not.toContain("isn't told you were asked");
    expect(all).not.toContain("no list of who played or who made a code");
  });

  it("H16: a role line appears only when Liz checked it and recorded what she checked", () => {
    expect(guestBlock(person({ roleText: "premarital counsellor" })).join(" ")).not.toContain("counsellor");
    expect(guestBlock(person({ roleText: "premarital counsellor", roleChecked: "practice website" })).join(" ")).not.toContain("counsellor");
    const shown = guestBlock(person({ roleText: "premarital counsellor", roleChecked: "practice website", roleCheckedAt: Date.UTC(2026, 10, 20) }))[1];
    expect(shown).toBe("Sister Jensen, premarital counsellor, checked by the studio on november 20, 2026 is a guest at this meetup. if you both want to talk your game through with Sister Jensen, you can make a share code for Sister Jensen. Sister Jensen sees nothing else about this meetup.");
  });

  it("H16 over HTTP: role_text is absent from the card payload unless it was checked", async () => {
    const unchecked = await h.person(JENSEN, "Sister Jensen", { roleText: "premarital counsellor" });
    const e = await h.event({ kind: "studio", level: 3, guestReaderId: unchecked });
    const card = await h.card(e.code);
    expect(card.status).toBe(200);
    expect(card.text).not.toContain("counsellor");
    expect(card.text).toContain("Sister Jensen is a guest at this meetup");
  });

  it("an unknown code, a closed event and host tools off all answer exactly as a path that was never built", async () => {
    const never = await h.get("/never-built-path");
    const off = await h.get("/events/card?meetup=never-was-a-code");
    expect(off.status).toBe(never.status);
    expect(off.text).toBe(never.text);
    const e = await h.event({});
    expect((await h.card(e.code)).status).toBe(200);
    await h.req("PATCH", `/admin/host-tools/events/${e.id}`, { closed: true }, ADMIN);
    const closed = await h.card(e.code);
    expect(closed.status).toBe(never.status);
    expect(closed.text).toBe(off.text);
    h.hostCfg = { ...h.hostCfg, enabled: false };
    const disabled = await h.card("anything-at-all");
    expect(disabled.status).toBe(never.status);
    expect(disabled.text).toBe(off.text);
  });

  it("a studio card: prototype label, studio lines, free, no host named anywhere", async () => {
    const e = await h.event({ name: "tuesday tea", lengthText: "two and a half hours" });
    const { card } = (await h.card(e.code)).body;
    expect(card.prototype).toBe(true);
    expect(card.eventName).toBe("tuesday tea");
    expect(card.hostLine).toBe("run by the studio that makes raising intelligences.");
    expect(card.lead).toBe("the studio is testing new host tools with real people. the studio made this meetup. everything below is exactly what happens. if anything changes, you'll see a new card first.");
    const flat = JSON.stringify(card);
    expect(flat).toContain("it's free at this meetup.");
    expect(flat).toContain("about two and a half hours. you'll raise one child from birth to 25");
    expect(flat).toContain(STUDIO_BLOCK);
    expect(flat).toContain("it's kept on the studio's own servers until the studio deletes it.");
    expect(flat).toContain("games from this meetup are never used in the studio's blog posts, research or AI training.");
    expect(flat).toContain("if you both say yes, you'll each see the other's Matrix handle");
    expect(card.hostName).toBeNull();
    expect(card.notForMe).toEqual(notForMeLines(false));
    expect(card.invite).toContain("it's free. invite prices can change.");
  });

  it("an outside L1 card names its host and shows only the L1 block", async () => {
    const dev = await h.person(DEV, "Dev");
    const e = await h.event({ kind: "outside", level: 1, hostPersonId: dev, handleExchange: false });
    const { card } = (await h.card(e.code)).body;
    expect(card.hostLine).toBe("hosted by Dev · ID-checked host, approved by the studio");
    const flat = JSON.stringify(card);
    expect(flat).toContain("Dev sees only rough totals for the whole meetup");
    expect(flat).not.toContain("share code");
    expect(flat).toContain("there's no contact swap at this meetup.");
    expect(flat).toContain("never shown to Dev. if you report someone, the report goes to the studio, not to Dev, and Dev isn't told.");
  });

  it("not for me and the invite clause follow the live paywall", () => {
    expect(notForMeLines(false)).toEqual([
      "that's fine. nothing about this is counted or passed on.",
      "you can raise a child on your own, free, or with someone you invite, also free.",
    ]);
    expect(notForMeLines(true)[1]).toBe("you can raise a child on your own, free. raising one with someone you invite is $20 per child, paid by whoever starts it, once they join.");
    const e = { kind: "studio", level: 0, cardVersion: 1, name: "x", welcomeText: "", lengthText: null, conductUrl: null, shareCodes: false, handleExchange: true } as unknown as HostEvent;
    const terms = { cost: "free" as const, traceRetentionDays: 30, traceWhere: "studio" as const, handleExchange: true, learning: true };
    const card = buildCard({ event: e, terms, host: null, guest: null, paywallOn: true, status: "open" });
    const flat = JSON.stringify(card);
    expect(flat).toContain("it's free at this meetup."); // frozen
    expect(card.invite).toContain("it's $20 per child, paid by whoever starts it, once the other person joins. invite prices can change.");
    expect(flat).toContain("it's kept on the studio's own servers for 30 days, then deleted.");
    expect(flat).toContain("if you both say so at the end, the studio may read your game");
  });

  it("report this host: no account needed; the report names no one", async () => {
    const e = await h.event({});
    expect((await h.post("/events/report-host", { meetup: e.code, text: "" })).status).toBe(400);
    const r = await h.post("/events/report-host", { meetup: e.code, text: "they asked people about their codes" });
    expect(r.body).toEqual({ ok: true });
    const list = await h.get("/admin/host-tools/host-reports", ADMIN);
    expect(list.body.reports).toHaveLength(1);
    expect(list.body.reports[0].eventId).toBe(e.id);
    expect(list.text).not.toContain(e.code);
  });
});
