import { describe, it, expect } from "vitest";
import { buildShareSnapshot, normaliseWords, OMITTED_COPY, sentences, type SnapshotSources } from "../src/hosts/share-snapshot.js";

/**
 * B2 / H9 / H5, and the game-wide rule from the 2.12 persona tests: a shared
 * artifact never quotes or describes private-talk content, and never names
 * anyone a player typed. The snapshot fails safe: only the report card's
 * sections about who the child became are kept, and any sentence that
 * quotes, echoes, retells or names is dropped.
 */

const SIDEBAR = "the blue door means grandma is listening tonight";
const CONFESSIONAL = "I once stole forty dollars from my aunt's purse";
const IDENTITY = "core belief that silence keeps the family from breaking apart";
const MEMORY = "remembers the night the car broke down near the quarry";

function card(extra = "", voices = true, quotes = true): string {
  return [
    "# Wren",
    "",
    "## Personality",
    `Curious and stubborn. Quick to laugh. Slow to trust adults she doesn't know. ${extra}`.trim(),
    "",
    "## Strengths",
    "- Reads people well. Keeps going when things are hard.",
    "",
    "## Struggles",
    "- Holds grudges. Finds apologies hard.",
    "",
    "## Pivotal Moments",
    `- At 7, her parents argued about the move. She learned that ${SIDEBAR}.`,
    "- At 12, she failed maths and Ash helped her study every night.",
    "",
    ...(voices ? ["## The Voices in Their Head", "### Ash", `"${SIDEBAR}"`, "### Bea", "Steady and quiet.", ""] : []),
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

function sources(over: Partial<SnapshotSources> = {}): SnapshotSources {
  return {
    typed: [`tell her ${SIDEBAR} and then go to sleep`, "we will always come back for you no matter what", CONFESSIONAL],
    privateTalk: [`tell her ${SIDEBAR} and then go to sleep`, CONFESSIONAL],
    derived: [IDENTITY, MEMORY],
    childName: "Wren",
    scenes: [],
    childLines: [],
    players: [["Ash", "Parent 1"], ["Bea", "Parent 2"]],
    ...over,
  };
}

function runsOf(text: string, n = 5): string[] {
  const w = normaliseWords(text);
  return Array.from({ length: Math.max(0, w.length - n + 1) }, (_, i) => w.slice(i, i + n).join(" "));
}
function containsRun(haystack: string, needle: string): boolean {
  const hay = normaliseWords(haystack).join(" ");
  return runsOf(needle).some((r) => hay.includes(r));
}
const all = (s: { reportCard: string | null; epilogue: string | null }) => `${s.reportCard ?? ""}\n${s.epilogue ?? ""}`;

describe("the share snapshot", () => {
  it("keeps only the report card's sections about who the child became; Pivotal Moments, Voices and Quotes never go", () => {
    const s = buildShareSnapshot(card(), EPILOGUE, sources());
    expect(s.reportCardOmitted).toBe(false);
    expect(s.reportCard).toContain("# Wren");
    expect(s.reportCard).toContain("## Personality");
    expect(s.reportCard).toContain("## Strengths");
    expect(s.reportCard).toContain("## Struggles");
    for (const gone of ["Pivotal Moments", "The Voices in Their Head", "Notable Quotes", "failed maths"]) expect(all(s)).not.toContain(gone);
    expect(containsRun(all(s), SIDEBAR)).toBe(false);
    expect(s.epilogue).toContain("She calls home on Sundays.");
  });

  it("a card with none of the kept sections is left out whole", () => {
    const s = buildShareSnapshot("# Wren\n## Where They Landed\nFine.\n## The Voices in Their Head\nx\n## Notable Quotes That Stuck\nx", EPILOGUE, sources());
    expect(s.reportCard).toBeNull();
    expect(s.reportCardOmitted).toBe(true);
  });

  it("H9: confessional, identity-document and memory-summary sentinels copied into the text are dropped", () => {
    const leaky = `${EPILOGUE} She ${CONFESSIONAL.toLowerCase()}, once.`;
    const s = buildShareSnapshot(card(`Her ${IDENTITY}. She ${MEMORY}.`), leaky, sources());
    for (const sentinel of [CONFESSIONAL, IDENTITY, MEMORY, SIDEBAR]) expect(containsRun(all(s), sentinel)).toBe(false);
  });

  it("a missing Voices or Quotes heading leaves out the whole report card (the model didn't follow the format), and the preview says so", () => {
    for (const c of [card("", false, true), card("", true, false)]) {
      const s = buildShareSnapshot(c, EPILOGUE, sources());
      expect(s.reportCard).toBeNull();
      expect(s.reportCardOmitted).toBe(true);
      expect(s.epilogue).not.toBeNull();
    }
    expect(OMITTED_COPY).toBe("your report card couldn't be trimmed safely, so a code would carry only the epilogue.");
  });

  describe("quotes, in every style, across sentences and lines", () => {
    const ep = (q: string) => `${q} She ran. She hid. She laughed. She slept. She woke.`;
    for (const [style, q] of [
      ["straight double", 'She said "go to bed" once.'],
      ["curly double", "She said “go to bed” once."],
      ["curly single (S1-2)", "Her mother once said ‘I am tired of pretending at church’ and never said it again."],
      ["straight single", "He said 'pray first, then pick up the hammer' every time."],
      ["guillemets", "Her mother's soft words — «we don't yell in this house» — stayed with her."],
      ["low-high", "She said „go to bed“ once."],
      ["corner brackets", "She said 「go to bed」 once."],
    ] as const) {
      it(`drops a quoted span of 2+ words: ${style}`, () => {
        const s = buildShareSnapshot(null, ep(q), sources({ typed: [], privateTalk: [], derived: [] }));
        expect(s.epilogue).not.toBeNull();
        expect(s.epilogue!.startsWith("She ran.")).toBe(true);
      });
    }

    it("apostrophes aren't quotes, and a one-word scare quote stays", () => {
      const s = buildShareSnapshot(null, "Wren's room was 'fine', she said. She didn't mind. She ran. She hid. She slept.", sources({ typed: [], privateTalk: [], derived: [] }));
      expect(s.epilogue).toContain("Wren's room was 'fine', she said.");
      expect(s.epilogue).toContain("She didn't mind.");
    });

    it("a quote split across sentences drops every sentence it touches (S1-2)", () => {
      const s = buildShareSnapshot(null, `Her rule was simple. "We don't yell in this house. We use soft words." She ran. She hid. She slept. She woke. She sang.`, sources({ typed: [], privateTalk: [], derived: [] }));
      expect(s.epilogue).toContain("Her rule was simple.");
      expect(s.epilogue).not.toContain("soft words");
      expect(s.epilogue).not.toContain("yell");
    });

    it("a quote split across lines drops both lines (S1-2)", () => {
      const text = ["He told her: \"You are loved.", "Always come home.\"", "She ran.", "She hid.", "She slept.", "She woke.", "She sang.", "She left."].join("\n");
      const s = buildShareSnapshot(null, text, sources({ typed: [], privateTalk: [], derived: [] }));
      expect(s.epilogue).not.toContain("loved");
      expect(s.epilogue).not.toContain("Always come home");
      expect(s.epilogue).toContain("She ran.");
    });

    it("an unclosed quote takes the rest of its paragraph with it", () => {
      const text = `She ran. She hid. She slept. She woke. She sang. She left. He said "come back soon. Please.\n\nShe stayed.`;
      const s = buildShareSnapshot(null, text, sources({ typed: [], privateTalk: [], derived: [] }));
      expect(s.epilogue).not.toContain("come back");
      expect(s.epilogue).not.toContain("Please");
      expect(s.epilogue).toContain("She stayed.");
    });
  });

  it("a run copied from what a player typed is caught across a sentence boundary", () => {
    const typed = ["the porch light stays on. you can always come home"];
    const s = buildShareSnapshot(null, "Things were calm. The porch light stays on. You can always come home, she knew. She ran. She hid. She slept. She woke.", sources({ typed, privateTalk: [], derived: [] }));
    expect(s.epilogue).not.toContain("porch light");
    expect(s.epilogue).not.toContain("come home");
  });

  it("a close paraphrase of a private line is dropped (S1-2: the purple giraffe)", () => {
    const priv = "The purple giraffe sings lullabies under the willow tree every single Tuesday night.";
    const text = "Eliza grew up hearing about a purple giraffe that sang lullabies beneath the willow on Tuesday nights. She ran. She hid. She slept. She woke. She sang.";
    const s = buildShareSnapshot(null, text, sources({ childName: "Eliza", typed: [priv], privateTalk: [priv], derived: [] }));
    expect(s.epilogue).not.toContain("giraffe");
  });

  it("a sentence that retells a secret or a confidence is dropped", () => {
    const s = buildShareSnapshot(null, "She kept her mother's secret for years. She confided in her father once. She ran. She hid. She slept. She woke. She sang. She left.", sources({ typed: [], privateTalk: [], derived: [] }));
    expect(s.epilogue).not.toContain("secret");
    expect(s.epilogue).not.toContain("confided");
  });

  describe("names (S1-2): only the game's own names survive", () => {
    const typed = [
      "When I was nineteen I told Bishop Halvorsen I had stopped seeing Jake Morrow, and I hadn't.",
      "I still keep my grandmother Ruth Ann Pratt's letters in a shoebox.",
      "My mission companion Elder Brandon Kowalski knew I nearly came home early from Fresno.",
      "Honestly my dad gary sorensen would have handled that better than me.",
      "our ward in Provo was small",
    ];
    const fill = " She ran. She hid. She slept. She woke. She sang. She left. She read. She swam. She drew. She grew.";
    for (const line of [
      "Bishop Halvorsen came up more than once in her teenage years.",
      "She was told about Jake Morrow only years later.",
      "She kept the letters of Ruth Ann Pratt close.",
      "She served a mission, like Elder Kowalski once had.",
      "Her grandfather, Gary Sorensen, was a hard man to please.",
      "Gary taught her to fish.",
      "The family's ties to the ward in Provo shaped her early faith.",
      "In Fresno she finally slept.",
    ]) {
      it(`drops: ${line}`, () => {
        const s = buildShareSnapshot(null, line + fill, sources({ typed, privateTalk: [], derived: [], childName: "Eliza" }));
        expect(s.epilogue).not.toBeNull();
        expect(s.epilogue).not.toContain(line.split(" ").slice(0, 3).join(" "));
        for (const n of ["Halvorsen", "Morrow", "Pratt", "Kowalski", "Sorensen", "Gary", "Provo", "Fresno"]) expect(s.epilogue).not.toContain(n);
      });
    }

    it("keeps the child's name and names the world generated (not typed by anyone)", () => {
      const s = buildShareSnapshot(null, `Eliza still visits Mrs. Okafor next door on Sundays.${fill}`, sources({
        typed, privateTalk: [], derived: [], childName: "Eliza", scenes: ["Mrs. Okafor from next door brings soup while Eliza sulks in the hall."],
      }));
      expect(s.epilogue).toContain("Eliza still visits Mrs. Okafor next door on Sundays.");
    });

    it("a scene name that a player also typed is still dropped", () => {
      const s = buildShareSnapshot(null, `Eliza still visits Bishop Halvorsen.${fill}`, sources({
        typed, privateTalk: [], derived: [], childName: "Eliza", scenes: ["Bishop Halvorsen waves from the chapel steps."],
      }));
      expect(s.epilogue).not.toContain("Halvorsen");
    });

    it("ordinary capitalised words, days, months and family words stay", () => {
      const s = buildShareSnapshot(null, `Eventually Eliza moved out. On Tuesday nights in December she calls Mom and Dad. God, she thought, it's cold.${fill}`, sources({ typed, privateTalk: [], derived: [], childName: "Eliza" }));
      expect(s.epilogue).toContain("Eventually Eliza moved out.");
      expect(s.epilogue).toContain("On Tuesday nights in December she calls Mom and Dad.");
    });
  });

  describe("H5: the players' names and nicknames become Parent 1 and Parent 2", () => {
    it("display names, whole-word, case-insensitive", () => {
      const s = buildShareSnapshot(card(), EPILOGUE, sources());
      expect(all(s)).not.toMatch(/\bAsh\b|\bBea\b/);
      expect(all(s)).toContain("Parent 2 taught her");
    });

    it("nicknames and diminutives (S1-2: Becca, Tommy)", () => {
      const fill = " She ran. She hid. She slept. She woke. She sang.";
      const s = buildShareSnapshot(null, `Tommy taught her to ride a bike. Becca's garden was the best on the street. Becky laughed. Thomas cooked.${fill}`, sources({
        typed: [], privateTalk: [], derived: [], childName: "Eliza", players: [["Rebecca", "Parent 1"], ["Tom", "Parent 2"]],
      }));
      expect(s.epilogue).toContain("Parent 2 taught her to ride a bike.");
      expect(s.epilogue).toContain("Parent 1's garden was the best on the street.");
      expect(s.epilogue).not.toMatch(/Tommy|Becca|Becky|Thomas|Rebecca/);
    });

    it("the child's name wins when it looks like a parent's nickname", () => {
      const s = buildShareSnapshot(null, "Tomas grew tall. She ran. She hid. She slept. She woke.", sources({
        typed: [], privateTalk: [], derived: [], childName: "Tomas", players: [["Tom", "Parent 1"], ["Ana", "Parent 2"]],
      }));
      expect(s.epilogue).toContain("Tomas grew tall.");
    });
  });

  it("the testers' whole probe: nothing typed, quoted or named survives", () => {
    const corpus = [
      "The purple giraffe sings lullabies under the willow tree every single Tuesday night.",
      "Remember what Grandpa said: \"pray first, then pick up the hammer\" always.",
      "Sister Abernathy from the third ward brought us her famous funeral potatoes.",
      "We don't yell in this house, sweetheart, we use soft words.",
      "When I was nineteen I told Bishop Halvorsen I had stopped seeing Jake Morrow, and I hadn't.",
      "I still keep my grandmother Ruth Ann Pratt's letters in a shoebox and read them when I can't pray.",
      "My mission companion Elder Brandon Kowalski knew I nearly came home early from Fresno.",
      "Honestly my dad Gary Sorensen would have handled that better than me.",
      "Becca, honey, I am so tired of pretending at church every week.",
      "Tommy promised he would never miss another family home evening.",
    ];
    const probeCard = [
      "# Eliza",
      "## Personality",
      "Eliza grew up hearing about a purple giraffe that sang lullabies beneath the willow on Tuesday nights.",
      "Tom often reminded her of Grandpa's rule to 'pray first, then pick up the hammer'.",
      "Warm. Watchful. Quick to forgive.",
      "## Strengths",
      "When Eliza was seven, Sister Abernathy from the third ward brought funeral potatoes after the loss.",
      "Rebecca kept her grandmother Ruth Ann Pratt's letters close, and read them on hard nights.",
      "Patient with younger kids. Good with her hands.",
      "## Struggles",
      "Rebecca's rule was simple. \"We don't yell in this house. We use soft words.\"",
      "Becca admitted she was tired of 'pretending at church every single week'.",
      "Bishop Halvorsen came up more than once in Eliza's teenage years.",
      "Tom worried he would never measure up to his father, Gary Sorensen.",
      "Asks for help late.",
      "## Pivotal Moments",
      "Tommy kept his promise about family home evening, mostly.",
      "## The Voices in Their Head",
      "### Parent 1",
      "Steady.",
      "## Notable Quotes That Stuck",
      "\"x\"",
    ].join("\n");
    const probeEpilogue = "Eliza still hums the song about the purple giraffe and the willow tree. She was told about Jake Morrow only years later, and she understood. Her mother's soft words — «we don't yell in this house» — stayed with her. He told her: \"You are loved.\nAlways come home.\" At twenty-five she served a mission, like her father's companion Elder Kowalski once had in Fresno. The family's ties to the ward in Provo shaped her early faith.";
    const s = buildShareSnapshot(probeCard, probeEpilogue, sources({
      typed: corpus, privateTalk: corpus, derived: [], childName: "Eliza", players: [["Rebecca", "Parent 1"], ["Tom", "Parent 2"]],
    }));
    const text = all(s);
    for (const leak of [
      "Halvorsen", "Sorensen", "Gary", "Kowalski", "Fresno", "Ruth Ann", "Pratt", "Jake", "Morrow", "Provo", "Abernathy",
      "giraffe", "pretending at church", "soft words", "yell", "You are loved", "come home", "hammer",
      "Becca", "Tommy", "Rebecca", "Grandpa's rule",
    ]) expect(text).not.toContain(leak);
    expect(text).not.toMatch(/\bTom\b/);
  });

  it("a part that would lose more than 40% of its sentences is left out", () => {
    const ep = [`Line one ${SIDEBAR}.`, `Line two ${SIDEBAR}.`, "Fine three.", "Fine four.", "Fine five."].join(" ");
    expect(buildShareSnapshot(null, ep, sources()).epilogue).not.toBeNull(); // 2 of 5 = 40%: kept
    const worse = [`One ${SIDEBAR}.`, `Two ${SIDEBAR}.`, `Three ${SIDEBAR}.`, "Fine four.", "Fine five."].join(" ");
    expect(buildShareSnapshot(null, worse, sources()).epilogue).toBeNull();
  });

  it("a shared-chat parent line repeated in the epilogue is removed", () => {
    const s = buildShareSnapshot(null, `${EPILOGUE} Her father always said we will always come back for you no matter what.`, sources());
    expect(s.epilogue).not.toContain("come back for you");
  });

  it("is deterministic: the same inputs give the same snapshot", () => {
    expect(buildShareSnapshot(card(), EPILOGUE, sources())).toEqual(buildShareSnapshot(card(), EPILOGUE, sources()));
  });

  it("sentences split after closing quotes", () => {
    expect(sentences('He said "stop." Then he left. Fine!')).toEqual(['He said "stop."', "Then he left.", "Fine!"]);
  });
});
