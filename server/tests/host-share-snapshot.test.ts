import { describe, it, expect } from "vitest";
import { buildShareSnapshot, normaliseWords, OMITTED_COPY, sentences } from "../src/hosts/share-snapshot.js";

/**
 * B2 / H9 / H5: what a share code carries. A sidebar sentinel planted in a
 * private message, and echoed everywhere the report card and epilogue could
 * carry it, never reaches the snapshot as a run of 6 words.
 */

const SIDEBAR = "the blue door means grandma is listening tonight";
const CONFESSIONAL = "I once stole forty dollars from my aunt's purse";
const IDENTITY = "core belief that silence keeps the family from breaking apart";
const MEMORY = "remembers the night the car broke down near the quarry";

function card(extraPivotal = "", voices = true, quotes = true): string {
  return [
    "# Wren",
    "",
    "## Personality",
    "Curious and stubborn. Quick to laugh. Slow to trust adults she doesn't know.",
    "",
    "## Strengths",
    "- Reads people well. Keeps going when things are hard.",
    "",
    "## Struggles",
    "- Holds grudges. Finds apologies hard.",
    "",
    "## Pivotal Moments",
    `- At 7, her parents argued about the move. She learned that ${SIDEBAR}. ${extraPivotal}`.trim(),
    "- At 12, she failed maths and Ash helped her study every night.",
    "- At 15, she came home late and nobody shouted.",
    "",
    ...(voices ? ["## The Voices in Their Head", "### Ash", `\"${SIDEBAR}\"`, "### Bea", "Steady and quiet.", ""] : []),
    ...(quotes ? ["## Notable Quotes That Stuck", `- “${SIDEBAR}”, said at bedtime.`, ""] : []),
  ].join("\n");
}

const EPILOGUE = [
  "Wren grew up in a house that was louder than most.",
  `At twenty-five she still thinks ${SIDEBAR}.`,
  "She calls home on Sundays. She keeps a plant alive, mostly.",
  "Bea taught her to fix a bike chain. She still does it the same way.",
  "She moved to the coast for work and loves the cold water.",
].join(" ");

const messages = [
  { sender: "parent1", chatType: "private", content: `tell her ${SIDEBAR} and then go to sleep` },
  { sender: "parent2", chatType: "shared", content: "we will always come back for you no matter what" },
  { sender: "child", chatType: "shared", content: "okay" },
];
const corpus = [...messages.filter((m) => m.sender !== "child").map((m) => m.content), CONFESSIONAL, IDENTITY, MEMORY];

function runsOf(text: string, n = 6): string[] {
  const w = normaliseWords(text);
  return Array.from({ length: Math.max(0, w.length - n + 1) }, (_, i) => w.slice(i, i + n).join(" "));
}
function containsRun(haystack: string, needle: string): boolean {
  const hay = normaliseWords(haystack).join(" ");
  return runsOf(needle).some((r) => hay.includes(r));
}

describe("the share snapshot", () => {
  it("B2: a sidebar sentinel in Voices, Notable Quotes, Pivotal Moments and the epilogue never reaches the snapshot", () => {
    const s = buildShareSnapshot(card(), EPILOGUE, corpus);
    expect(s.reportCardOmitted).toBe(false);
    expect(s.reportCard).not.toBeNull();
    expect(s.epilogue).not.toBeNull();
    const all = `${s.reportCard}\n${s.epilogue}`;
    expect(containsRun(all, SIDEBAR)).toBe(false);
    expect(all).not.toContain("The Voices in Their Head");
    expect(all).not.toContain("Notable Quotes");
    expect(s.reportCard).toContain("## Pivotal Moments");
    expect(s.reportCard).toContain("she failed maths");
    expect(s.epilogue).toContain("She calls home on Sundays.");
  });

  it("H9: confessional, identity-document and memory-summary sentinels copied into the text are dropped", () => {
    const leaky = `${EPILOGUE} She ${CONFESSIONAL.toLowerCase()}, once.`;
    const leakyCard = card(`Her ${IDENTITY}. She ${MEMORY}.`);
    const s = buildShareSnapshot(leakyCard, leaky, corpus);
    const all = `${s.reportCard ?? ""}\n${s.epilogue ?? ""}`;
    for (const sentinel of [CONFESSIONAL, IDENTITY, MEMORY, SIDEBAR]) expect(containsRun(all, sentinel)).toBe(false);
  });

  it("a missing Voices or Quotes heading leaves out the whole report card, and the preview says so", () => {
    for (const c of [card("", false, true), card("", true, false)]) {
      const s = buildShareSnapshot(c, EPILOGUE, corpus);
      expect(s.reportCard).toBeNull();
      expect(s.reportCardOmitted).toBe(true);
      expect(s.epilogue).not.toBeNull();
    }
    expect(OMITTED_COPY).toBe("your report card couldn't be trimmed safely, so a code would carry only the epilogue.");
  });

  it("a quoted span of 4+ words is dropped; 3 words are kept", () => {
    const s = buildShareSnapshot(null, 'She said "go to your room" once. She said "not now" twice. She laughed. She ran. She hid.', []);
    expect(s.epilogue).not.toContain("go to your room");
    expect(s.epilogue).toContain('"not now"');
  });

  it("a part that would lose more than 40% of its sentences is left out", () => {
    const ep = [`Line one ${SIDEBAR}.`, `Line two ${SIDEBAR}.`, "Fine three.", "Fine four.", "Fine five."].join(" ");
    expect(buildShareSnapshot(null, ep, corpus).epilogue).not.toBeNull(); // 2 of 5 = 40%: kept
    const worse = [`One ${SIDEBAR}.`, `Two ${SIDEBAR}.`, `Three ${SIDEBAR}.`, "Fine four.", "Fine five."].join(" ");
    expect(buildShareSnapshot(null, worse, corpus).epilogue).toBeNull();
  });

  it("a shared-chat parent line repeated in the epilogue is removed", () => {
    const s = buildShareSnapshot(null, `${EPILOGUE} Her father always said we will always come back for you no matter what.`, corpus);
    expect(s.epilogue).not.toContain("come back for you");
  });

  it("H5: the parents' display names become Parent 1 and Parent 2", () => {
    const s = buildShareSnapshot(card(), EPILOGUE, corpus, [["Ash", "Parent 1"], ["Bea", "Parent 2"]]);
    const all = `${s.reportCard}\n${s.epilogue}`;
    expect(all).not.toMatch(/\bAsh\b|\bBea\b/);
    expect(all).toContain("Parent 1 helped her study");
    expect(all).toContain("Parent 2 taught her");
  });

  it("is deterministic: the same inputs give the same snapshot", () => {
    expect(buildShareSnapshot(card(), EPILOGUE, corpus)).toEqual(buildShareSnapshot(card(), EPILOGUE, corpus));
  });

  it("sentences split after closing quotes", () => {
    expect(sentences('He said "stop." Then he left. Fine!')).toEqual(['He said "stop."', "Then he left.", "Fine!"]);
  });
});
