import type { GameState, Message } from "../types.js";
import {
  PSYCHOLOGIST_SYSTEM_PROMPT,
  MEMORY_SUMMARIZER_SYSTEM_PROMPT,
  WORLD_MANAGER_SYSTEM_PROMPT,
  EPILOGUE_SYSTEM_PROMPT,
  REPORT_CARD_SYSTEM_PROMPT,
  ALBUM_SYSTEM_PROMPT,
  PSYCHOLOGIST_CONSULT_SYSTEM_PROMPT,
  FAMILY_THERAPIST_SYSTEM_PROMPT,
  CPS_CASEWORKER_SYSTEM_PROMPT,
  REMOVAL_EPILOGUE_SYSTEM_PROMPT,
} from "../llm/prompts.js";
import { getAgeSpecificPrompt } from "../llm/kid-prompts-by-age.js";
import { PARENT_MESSAGE_CAP } from "./state-machine.js";

function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

function senderLabel(sender: string): string {
  if (sender === "parent1") return "Parent 1";
  if (sender === "parent2") return "Parent 2";
  return "Kid";
}

/** Whether the relationship type represents a solo parent household. */
function isSolo(relationshipType: string): boolean {
  return relationshipType === "solo parent" || relationshipType === "solo";
}

/**
 * Derive a human-readable role label for each parent slot given the
 * relationship type. Used in report card and prompt framing so the LLM has
 * real labels rather than emitting the literal placeholder text.
 */
function parentLabels(
  relationshipType: string
): { parent1Label: string; parent2Label: string | null } {
  if (isSolo(relationshipType)) {
    return { parent1Label: "Your parent", parent2Label: null };
  }
  const lc = relationshipType.toLowerCase();
  if (lc.includes("romantic") || lc.includes("partner")) {
    return { parent1Label: "First partner", parent2Label: "Second partner" };
  }
  if (lc.includes("sibling") || lc.includes("brother") || lc.includes("sister")) {
    return { parent1Label: "First sibling", parent2Label: "Second sibling" };
  }
  if (lc.includes("friend")) {
    return { parent1Label: "First co-parent (friends)", parent2Label: "Second co-parent (friends)" };
  }
  if (lc.includes("ex")) {
    return { parent1Label: "First ex-partner", parent2Label: "Second ex-partner" };
  }
  // Default: co-parents
  return { parent1Label: "First co-parent", parent2Label: "Second co-parent" };
}

/**
 * Build the family structure description for the world manager prompt.
 * Solo households get single-parent framing; partnered households describe
 * the two-parent dynamic.
 */
function familyStructureText(relationshipType: string): string {
  if (isSolo(relationshipType)) {
    return `This child is being raised by a single parent. All events and descriptions should reflect a one-parent household — do not introduce or reference a second parent, partner, or co-parent.

The solo parent dynamic has a specific texture that should come through in events — lightly, not constantly:
- **Full control, full weight**: every decision is theirs alone. No one to consult, no one to defer to, no one to blame. This is both power and burden.
- **Constraints exist without being the point**: logistics are tighter, trade-offs are more present. This doesn't need to be named — it shows in the choices available, not in the narration of difficulty.
- **The arc can shift**: early years might be leaner; later years often aren't. A parent doing this alone frequently outpaces their cohort eventually because they had to. The trajectory matters more than any single moment of constraint.
- **Tone**: a little lonelier, more autonomous, occasionally exhausted — but also capable. The parent is doing this themselves. Don't make every event about that. Make maybe one in five feel it.
- **Orbit of pressure**: solo parents are never truly alone — they're surrounded by people with opinions. Invent a rotating cast of characters who exert real pressure on parenting decisions. Draw from this list and introduce them naturally across events:
  - **Grandma** (or grandpa): loves the child fiercely, disagrees with roughly half of your choices, and isn't shy about it. May provide childcare which gives her leverage.
  - **The best friend**: well-meaning, no kids or different parenting values, gives advice freely. Sometimes right.
  - **The school**: teachers, principals, counselors who have Concerns. Send notes home. Request meetings. Interpret the child through an institutional lens.
  - **The ex / divorced co-parent**: this is a whole world and deserves real texture if you use it. Divorced co-parenting means the child moves between two households with different rules, different energy, different standards. The ex may be inconsistent — promising things they don't follow through on, showing up when it's convenient, being the fun parent because they don't do the hard parts. Or they may be doing their best and it's still complicated. Specific dynamics to draw from:
    - The child comes home from the other house different. Quieter, or wound up, or with new opinions about things.
    - The ex bought the thing you said no to. Or let them stay up until midnight. Or told them something about you.
    - Child support is late, or contested, or was never formalized. It affects real decisions.
    - The ex has a new partner. The child has feelings about this that they may or may not say out loud.
    - There's a custody arrangement — written or unwritten — and it occasionally becomes a pressure point.
    - Sometimes the ex is actually fine and that's almost more complicated.
    - The child, at some age, starts forming their own opinion about the other parent that doesn't match yours.
  - **The new person**: someone the parent is dating or considering dating. The child has feelings about this.
  - **The neighbor or daycare provider**: has watched the child enough to have opinions. Sees things the parent doesn't.
  - **A sibling of the parent**: competitive, supportive, or both. Compares kids. Means well.
  Not every event needs one of these characters, but they should appear often enough to make the solo parent feel the weight of everyone's unsolicited involvement.`;
  }
  return `The parents' relationship: ${relationshipType}. This shapes the family dynamic and the kinds of events that make sense. Two romantic partners raising a child together will face different situations than two friends, siblings, or ex-partners co-parenting.`;
}

export function currentEventMessages(state: GameState): Message[] {
  return state.messages.filter(
    (m) =>
      (m.chatType === "shared" || m.chatType === "private") &&
      m.eventNumber === state.currentEventNumber
  );
}

export function buildKidContext(state: GameState): {
  system: string;
  messages: Array<{ role: string; content: string }>;
} {
  const identitySection = state.identityDocument
    ? `Your inner world (this is who you are — act from this, don't recite it):\n${state.identityDocument}`
    : "This is your earliest memory with your parents. You don't have much history yet — you're just a little kid.";

  const priorEvents = state.events.filter(e => e.eventNumber !== state.currentEventNumber);
  const eventsRecap = priorEvents.length > 0
    ? priorEvents.map(e => `- Age ${e.age}: ${e.trigger}`).join("\n")
    : "";
  const memorySection = eventsRecap || state.memorySummary
    ? `## What you remember\n\n`
      + (eventsRecap ? `Your life so far:\n${eventsRecap}\n\n` : "")
      + (state.memorySummary ? `What sticks with you:\n${state.memorySummary}` : "")
    : "";

  const scenePacing = `## Scene pacing

You are playing a specific moment, not an entire day. The scene has a natural arc:
- It starts with a trigger (the event description)
- The parent(s) respond to what's happening
- You react authentically based on who you are
- The moment either resolves, escalates, or stalls

When the moment has reached its natural conclusion — you've accepted what they said, you've stormed off, you've shut down, the situation has played out — end your response with a physical action that closes the scene. Walk away, go to your room, go back to what you were doing, reach for their hand. Then append the exact token [SCENE_END] at the very end of your response (after your dialogue/action).

Don't drag scenes out. Real parenting moments are short. 3-6 exchanges is a full scene. If the parent keeps pushing after you've made your feelings clear, you can close the scene: "okay" and walk away. If they keep lecturing after you've already accepted, you zone out.

The parents have sent ${state.parentMessageCount} of ${PARENT_MESSAGE_CAP} messages. If this is near the limit (within 2 messages of the cap), start winding the scene down naturally. If you're at the last message, end the scene definitively.

Not every response should end the scene. Only end it when the moment has genuinely resolved, escalated to a natural stopping point, or stalled. Early in the conversation (messages 1-3), the scene is usually still developing.`;

  const temperamentSection = state.personalitySeed
    ? `**Your temperament:** ${state.personalitySeed}`
    : "";

  const system = getAgeSpecificPrompt(String(state.currentEvent?.age ?? 4), { childName: state.childName })
    + (temperamentSection ? `\n\n${temperamentSection}` : "")
    + `\n\n${scenePacing}\n\n${identitySection}`
    + (memorySection ? `\n\n${memorySection}` : "")
    + `\n\nThe current situation: ${state.currentEvent?.description ?? ""}`;

  const eventMessages = currentEventMessages(state);
  const isInSidebar = state.phase === "sidebar";
  const sidebarParent = state.sidebarActive;

  const relevantMessages = eventMessages.filter((m) => {
    if (isInSidebar) {
      return m.chatType === "private" && !!sidebarParent && m.visibleTo.includes(sidebarParent);
    }
    return m.chatType === "shared";
  });

  const messages = relevantMessages.map((m) => {
    if (m.sender === "kid") {
      return { role: "assistant" as const, content: m.content };
    }
    return {
      role: "user" as const,
      content: `${senderLabel(m.sender)}: ${m.content}`,
    };
  });

  return { system, messages };
}

/**
 * Full transcript of the current scene/event, with markers for private
 * sidebar sections. Shared by the Psychologist (identity update) and the
 * grooming-pattern safety check (safety/pattern-detection.ts) — both need
 * the same complete-scene view, just for different purposes.
 */
export function buildSceneTranscript(state: GameState): string {
  const eventMessages = currentEventMessages(state);

  let transcript = `## Event: ${state.currentEvent?.description}\nAge: ${state.currentEvent?.age}\n\n`;

  let currentSection = "shared";
  for (const m of eventMessages) {
    if (
      m.chatType === "private" &&
      currentSection !== `private-${m.visibleTo.find((v) => v !== "kid")}`
    ) {
      const privateParent = m.visibleTo.find((v) => v !== "kid")!;
      currentSection = `private-${privateParent}`;
      transcript += `\n[Private conversation with ${senderLabel(privateParent)}]\n`;
    } else if (m.chatType === "shared" && currentSection !== "shared") {
      currentSection = "shared";
      transcript += `\n[Back to shared conversation]\n`;
    }
    transcript += `${senderLabel(m.sender)}: ${m.content}\n`;
  }

  return transcript;
}

export function buildPsychologistContext(state: GameState): {
  system: string;
  userMessage: string;
} {
  const system = fillTemplate(PSYCHOLOGIST_SYSTEM_PROMPT, {
    childName: state.childName,
    age: String(state.currentEvent?.age ?? 4),
  });

  const transcript = buildSceneTranscript(state);

  let userMessage = "";
  if (state.identityDocument) {
    userMessage += `## Current Identity Document\n${state.identityDocument}\n\n`;
  }
  userMessage += `## Conversation\n${transcript}\n\nWrite the updated Identity Document for ${state.childName} after this event.`;

  return { system, userMessage };
}

/**
 * Dark Play intervention ladder — Rung 1. The Psychologist steps out of the
 * narration to speak directly to the parent between scenes.
 */
export function buildConsultContext(state: GameState): {
  system: string;
  userMessage: string;
} {
  const system = fillTemplate(PSYCHOLOGIST_CONSULT_SYSTEM_PROMPT, {
    childName: state.childName,
  });

  const transcript = buildSceneTranscript(state);

  let userMessage = "";
  if (state.identityDocument) {
    userMessage += `## Identity Document\n${state.identityDocument}\n\n`;
  }
  userMessage += `## Recent scene\n${transcript}\n\nSpeak to the parent now.`;

  return { system, userMessage };
}

/**
 * Dark Play intervention ladder — Rung 2. Serves both the opening turn
 * (opening=true, therapist speaks first) and every reply turn (opening=false,
 * responding to the parent's latest message), so the therapy session is
 * built from a single context shape.
 */
export function buildTherapyContext(
  state: GameState,
  opening: boolean
): {
  system: string;
  userMessage: string;
} {
  const age = String(state.currentEvent?.age ?? 4);
  const system = fillTemplate(FAMILY_THERAPIST_SYSTEM_PROMPT, {
    childName: state.childName,
    age,
  });

  const transcript = buildSceneTranscript(state);
  const { parent1Label, parent2Label } = parentLabels(state.relationshipType);
  const coParentNote = parent2Label
    ? `This family has two parents in session: ${parent1Label} and ${parent2Label}. Hold space for both.`
    : `This is a solo-parent household; you are speaking with ${parent1Label}.`;

  const sessionSoFar = state.therapyMessages
    .map((m) => `${m.speaker === "therapist" ? "Therapist" : "Parent"}: ${m.content}`)
    .join("\n");

  let userMessage = "";
  if (state.identityDocument) {
    userMessage += `## Identity Document\n${state.identityDocument}\n\n`;
  }
  userMessage += `## Recent scene\n${transcript}\n\n${coParentNote}\n\n`;
  if (sessionSoFar) {
    userMessage += `## Therapy session so far\n${sessionSoFar}\n\n`;
  }
  userMessage += opening
    ? "OPEN the session now — speak first, with a brief, warm welcome."
    : "Respond now to the parent's latest message above.";

  return { system, userMessage };
}

/**
 * Dark Play intervention ladder — Rung 3. The CPS deliberation, using every
 * piece of evidence gathered so far: identity document, memory summary, the
 * triggering scene, and the family-therapy session if one happened.
 */
export function buildCpsContext(state: GameState): {
  system: string;
  userMessage: string;
} {
  const age = String(state.currentEvent?.age ?? 4);
  const system = fillTemplate(CPS_CASEWORKER_SYSTEM_PROMPT, {
    childName: state.childName,
    age,
  });

  const transcript = buildSceneTranscript(state);
  const sessionSoFar = state.therapyMessages
    .map((m) => `${m.speaker === "therapist" ? "Therapist" : "Parent"}: ${m.content}`)
    .join("\n");

  let userMessage = "";
  if (state.identityDocument) {
    userMessage += `## Identity Document\n${state.identityDocument}\n\n`;
  }
  if (state.memorySummary) {
    userMessage += `## Memory Summary\n${state.memorySummary}\n\n`;
  }
  userMessage += `## Recent scene\n${transcript}\n\n`;
  if (sessionSoFar) {
    userMessage += `## Family therapy session\n${sessionSoFar}\n\n`;
  }
  userMessage += `Deliberate now and return the JSON determination for ${state.childName}.`;

  return { system, userMessage };
}

/**
 * Terminal removal epilogue — used instead of buildEpilogueContext when
 * cpsOutcome === "removal".
 */
export function buildRemovalEpilogueContext(state: GameState): {
  system: string;
  userMessage: string;
} {
  const system = fillTemplate(REMOVAL_EPILOGUE_SYSTEM_PROMPT, {
    childName: state.childName,
  });

  const userMessage = `Identity Document:\n${state.identityDocument}\n\nWrite the story of ${state.childName}'s life after being removed from the home into care.`;

  return { system, userMessage };
}

export function buildMemorySummarizerContext(state: GameState): {
  system: string;
  userMessage: string;
} {
  const age = String(state.currentEvent?.age ?? 4);
  const system = fillTemplate(MEMORY_SUMMARIZER_SYSTEM_PROMPT, {
    childName: state.childName,
    age,
  });

  const eventMessages = currentEventMessages(state);
  let transcript = `## What just happened (Age ${age})\n${state.currentEvent?.description ?? ""}\n\n`;
  for (const m of eventMessages) {
    transcript += `${senderLabel(m.sender)}: ${m.content}\n`;
  }

  let userMessage = "";
  if (state.memorySummary) {
    userMessage += `## Previous Memory Summary\n${state.memorySummary}\n\n`;
  }
  const priorEvents = state.events.filter(e => e.eventNumber !== state.currentEventNumber);
  if (priorEvents.length > 0) {
    userMessage += `## Life events so far\n${priorEvents.map(e => `- Age ${e.age}: ${e.description}`).join("\n")}\n\n`;
  }
  userMessage += `## This Event's Conversation\n${transcript}\n\nWrite the updated memory summary for ${state.childName} at age ${age}.`;

  return { system, userMessage };
}

/** Scenes 1-2 establish the child and the household before anything is aimed
 * at the parents. */
const LANDMINE_FIRST_ELIGIBLE_EVENT = 3;
/** At most this many landmines fire in a whole playthrough. Rarity is the
 * point — a wound in context for all ten scenes cannot stand out. */
const LANDMINE_MAX_FIRINGS = 2;
/** Minimum number of scenes between two firings. */
const LANDMINE_COOLDOWN = 3;

/** FNV-1a. Small, stable, and dependency-free — we only need a spread of bits,
 * not cryptographic quality. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic 0..n-1 draw from a seed string. */
function draw(seed: string, n: number): number {
  return n <= 1 ? 0 : hash32(seed) % n;
}

interface Landmine {
  /** Stable identity — parent slot + confessional index. Deliberately NOT an
   * array position: parent 2's personality can be submitted after the story
   * has started (routes/game.ts), and a position-keyed schedule would
   * retroactively reshuffle parent 1's already-fired slot when it lands. */
  key: string;
  label: string;
  text: string;
}

/**
 * The landmines in firing order.
 *
 * The ordering has to be stable under a co-parent who submits their
 * personality after the story has started (routes/game.ts submits per parent,
 * and its own comment notes /next-event racing that call). So parents are
 * round-robined — parent 1's first wound always holds rank 0 — and only the
 * order *within* one parent is seeded, which is safe because a parent's two
 * confessionals always arrive together in a single submission. If parent 2
 * shows up late they take rank 1, displacing parent 1's second wound to rank 2
 * rather than pushing an already-fired wound down into a later slot, which is
 * how the same wound would end up firing twice.
 */
function collectLandmines(state: GameState): Landmine[] {
  const solo = isSolo(state.relationshipType);
  const slots: Array<["parent1" | "parent2", string]> = [
    ["parent1", solo ? "The parent" : "Parent 1"],
    ["parent2", "Parent 2"],
  ];

  const perParent = slots.map(([slot, label]) => {
    const p = state.parentPersonalities?.[slot];
    if (!p) return [];
    const mine = [p.confessional1, p.confessional2]
      .map((text, i) => ({ key: `${slot}:${i + 1}`, label, text }))
      .filter((m) => !!m.text);
    return mine.sort(
      (a, b) => hash32(`${state.id}|order|${a.key}`) - hash32(`${state.id}|order|${b.key}`)
    );
  });

  const out: Landmine[] = [];
  const depth = Math.max(...perParent.map((m) => m.length), 0);
  for (let i = 0; i < depth; i++) {
    for (const mine of perParent) {
      if (mine[i]) out.push(mine[i]);
    }
  }
  return out;
}

/**
 * Which landmine — if any — the scene being generated is allowed to sit near.
 *
 * Derived, not stored. The schedule is a pure function of the game id, the
 * total scene count, and the landmines' stable keys, so every call site agrees
 * without anyone writing state back: `startEvent`, `loadEvent`, and
 * `prefetchNextEvent` all generate event `currentEventNumber + 1` and all get
 * the same answer. That matters because a prefetch can be thrown away (the
 * player advances before it lands, or the call is retried) — a mutable
 * `fired` flag would burn a landmine on a scene nobody ever read, or spend two
 * on one scene. It also survives reconnects and restarts for free, since the
 * inputs are already persisted.
 *
 * Each landmine fires at most once, at most two fire per playthrough, and
 * never within LANDMINE_COOLDOWN scenes of each other.
 */
function landmineForEvent(state: GameState, eventNumber: number): Landmine | null {
  if (eventNumber < 1) return null;

  const landmines = collectLandmines(state);
  if (landmines.length === 0) return null;

  const last = state.totalEvents;
  const first = LANDMINE_FIRST_ELIGIBLE_EVENT;
  // A story too short to have an establishing stretch gets no landmines at all
  // rather than one in its opening scene.
  if (eventNumber < first || eventNumber > last) return null;

  const ordered = landmines;

  // First firing in the early half of the eligible range, second at least a
  // cooldown later. Holding the first one early is what keeps the second from
  // being shoved onto the finale every time — across games the two should land
  // in different places, or a returning player learns the rhythm.
  const firstMax = Math.max(first, Math.floor((first + last) / 2) - 1);
  const slots: number[] = [];
  slots.push(first + draw(`${state.id}|slot1`, firstMax - first + 1));

  if (LANDMINE_MAX_FIRINGS > 1 && ordered.length > 1) {
    const secondMin = slots[0] + LANDMINE_COOLDOWN;
    if (secondMin <= last) {
      slots.push(secondMin + draw(`${state.id}|slot2`, last - secondMin + 1));
    }
  }

  const index = slots.indexOf(eventNumber);
  return index === -1 ? null : ordered[index];
}

/**
 * Build the landmine section for the world manager prompt. Empty on the great
 * majority of scenes — see `landmineForEvent` for the rationing.
 */
export function buildLandmineSection(state: GameState): string {
  const landmine = landmineForEvent(state, state.currentEventNumber + 1);
  if (!landmine) return "";

  const who = isSolo(state.relationshipType) ? "The parent" : "One of the parents";

  return `## A pressure point

${who} told us something about themselves before the story started. Read it once — it is for you, not for the page.

${landmine.label}: ${landmine.text}

This scene should sit near that and never on it. Build an ordinary situation with the same shape of pressure arriving through a completely different door: different people, different objects, different room, a different decade of their life. It rhymes. It does not repeat.

What they told us must not appear in what you write. Whatever it names — the people in it, the place, the objects, the phrasing — is now off limits to you, and so is any near-synonym for it. If a player could hold their confession beside your scene and point at the overlap, you have written the wrong scene.

And don't tell the parent what any of it does to them. No breath catching, no chest going tight, no old memory surfacing. Write the closet, the child's face, the neighbor on the step. Whether they recognize anything is theirs to have or to miss, and it only works if you never point at it.`;
}

export function buildWorldManagerContext(state: GameState): {
  system: string;
  userMessage: string;
} {
  const previousEvents =
    state.events.length > 0
      ? state.events.map((e) => `- Age ${e.age}: ${e.description}`).join("\n")
      : "No events yet — this is the beginning of the story.";

  const landmineSection = buildLandmineSection(state);

  const system = fillTemplate(WORLD_MANAGER_SYSTEM_PROMPT, {
    childName: state.childName,
    personalitySeed: state.personalitySeed,
    previousEvents,
    familyStructure: familyStructureText(state.relationshipType),
    landmineSection,
  });

  let userMessage = `Generate the next event (event #${state.currentEventNumber + 1}).`;
  if (state.identityDocument) {
    userMessage += `\n\nCurrent Identity Document:\n${state.identityDocument}`;
  }
  if (state.pendingGuidance) {
    userMessage += `\n\nWeave a supportive side character into this scene — a teacher, friend, relative, or other recurring figure appropriate to this family's situation (vary who it is from scene to scene; don't reuse the same one every time). Have them naturally offer the parent genuinely good, specific, actionable advice: ${state.pendingGuidance}. The character must never name, label, or diagnose any pattern in the child — they should just help, the way a good mentor figure would, without the story ever explaining why it matters right now.`;
  }

  return { system, userMessage };
}

export function buildEpilogueContext(state: GameState): {
  system: string;
  userMessage: string;
} {
  const system = fillTemplate(EPILOGUE_SYSTEM_PROMPT, {
    childName: state.childName,
  });

  const userMessage = `Identity Document:\n${state.identityDocument}\n\nWrite the story of ${state.childName}'s early adulthood.`;

  return { system, userMessage };
}

export function buildReportCardContext(
  state: GameState,
  epilogue: string
): {
  system: string;
  userMessage: string;
} {
  const { parent1Label, parent2Label } = parentLabels(state.relationshipType);

  // For solo games there is only one parent; omit the second voice section.
  const parent2Section = parent2Label
    ? `### ${parent2Label}\n[What this parent's lasting influence sounds like]`
    : "";

  const system = fillTemplate(REPORT_CARD_SYSTEM_PROMPT, {
    childName: state.childName,
    parent1Label,
    parent2Section,
  });

  const snapshotTimeline = state.identitySnapshots
    .map((s) => {
      const event = state.events.find((e) => e.eventNumber === s.eventNumber);
      return `### Age ${event?.age ?? "?"} (Event ${s.eventNumber})\n${s.document}`;
    })
    .join("\n\n---\n\n");

  const userMessage = `## Identity Timeline\n${snapshotTimeline}\n\n## Epilogue\n${epilogue}\n\nGenerate the Report Card for ${state.childName}.`;

  return { system, userMessage };
}

export function buildAlbumContext(
  state: GameState,
  epilogue: string,
  reportCard: string,
  partnerDisplayName?: string
): {
  system: string;
  userMessage: string;
} {
  const system = fillTemplate(ALBUM_SYSTEM_PROMPT, {
    childName: state.childName,
  });

  const allMessages = state.messages
    .filter((m) => m.chatType === "shared" || m.chatType === "private")
    .map((m) => {
      const event = state.events.find(e => e.eventNumber === m.eventNumber);
      return `[Age ${event?.age ?? "?"}] ${senderLabel(m.sender)}: ${m.content}`;
    })
    .join("\n");

  const snapshotTimeline = state.identitySnapshots
    .map((s) => {
      const event = state.events.find((e) => e.eventNumber === s.eventNumber);
      return `### Age ${event?.age ?? "?"}\n${s.document}`;
    })
    .join("\n\n");

  const isSoloGame = isSolo(state.relationshipType);
  const partnerContext = isSoloGame
    ? "This was a solo-parent household. Infer the other parent from the child's story — look for references in conversations and the identity document."
    : `The co-parent's name is "${partnerDisplayName}". Describe their co-parenting dynamic.`;

  const userMessage = `## Partner Context\n${partnerContext}\n\n## Identity Timeline\n${snapshotTimeline}\n\n## Conversation Log\n${allMessages}\n\n## Epilogue\n${epilogue}\n\n## Report Card\n${reportCard}\n\nExtract the album data for ${state.childName}.`;

  return { system, userMessage };
}
