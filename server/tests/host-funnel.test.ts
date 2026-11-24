import { describe, it, expect } from "vitest";
import { publishFunnel, band, proportion } from "../src/hosts/funnel.js";

/** Spec §4.2: bands, proportions, the minimum size. Never a count, a zero, "all" or "none". */
describe("the published funnel", () => {
  it("below 5 games started, nothing but 'too small'", () => {
    for (let s = 0; s < 5; s++) expect(publishFunnel({ joined: 40, started: s, finished: s, swapped: s })).toEqual({ tooSmall: true });
  });

  it("sizes are bands", () => {
    expect([5, 9, 10, 19, 20, 49, 50, 400].map(band)).toEqual(["5–9", "5–9", "10–19", "10–19", "20–49", "20–49", "50+", "50+"]);
  });

  it("outcomes are hidden under 10 started, and otherwise only 'more than half' or 'half or fewer'", () => {
    expect(publishFunnel({ joined: 12, started: 6, finished: 6, swapped: 0 })).toEqual({
      tooSmall: false, joined: "10–19", started: "5–9", finished: "not shown at this size", swapped: "not shown at this size",
    });
    expect(proportion(0, 10)).toBe("half or fewer"); // never "none" or 0
    expect(proportion(10, 10)).toBe("more than half"); // never "all"
    expect(proportion(5, 10)).toBe("half or fewer");
    expect(proportion(6, 10)).toBe("more than half");
  });

  it("the swap cell is absent where the exchange was off; joined never reads below started", () => {
    const f = publishFunnel({ joined: 3, started: 20, finished: 15, swapped: null });
    expect(f).toEqual({ tooSmall: false, joined: "20–49", started: "20–49", finished: "more than half", swapped: null });
  });

  it("no cell is ever a number", () => {
    for (let s = 0; s < 120; s += 7) {
      const f = publishFunnel({ joined: s * 2, started: s, finished: Math.floor(s / 3), swapped: s });
      expect(JSON.stringify(f)).not.toMatch(/"\d+"|:\d/);
    }
  });

  it("B5: exhaustive over started 0–60 — every shown outcome covers at least two values, one not extreme", () => {
    for (let started = 0; started <= 60; started++) {
      const seen = new Map<string, number[]>();
      for (let n = 0; n <= started; n++) {
        const f = publishFunnel({ joined: started * 2, started, finished: n, swapped: n });
        if (started < 5) { expect(f).toEqual({ tooSmall: true }); continue; }
        if (f.tooSmall) throw new Error("unexpected");
        expect(f.finished).toBe(f.swapped);
        if (started < 10) { expect(f.finished).toBe("not shown at this size"); continue; }
        expect(["more than half", "half or fewer"]).toContain(f.finished);
        seen.set(f.finished, [...(seen.get(f.finished) ?? []), n]);
      }
      for (const values of seen.values()) {
        expect(values.length).toBeGreaterThanOrEqual(2);
        expect(values.some((v) => v !== 0 && v !== started)).toBe(true);
      }
    }
  });
});
