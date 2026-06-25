import type { GameState, Message } from "../types.js";
import {
  PSYCHOLOGIST_SYSTEM_PROMPT,
  WORLD_MANAGER_SYSTEM_PROMPT,
  EPILOGUE_SYSTEM_PROMPT,
  REPORT_CARD_SYSTEM_PROMPT,
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

function currentEventMessages(state: GameState): Message[] {
  return state.messages.filter(
    (m) => m.chatType === "shared" || m.chatType === "private"
  );
}

export function buildKidContext(state: GameState): {
  system: string;
  messages: Array<{ role: string; content: string }>;
} {
  const identitySection = state.identityDocument
    ? `Your inner world (this is who you are — act from this, don't recite it):\n${state.identityDocument}`
    : "This is your earliest memory with your parents. You don't have much history yet — you're just a little kid.";

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
    + `\n\n${scenePacing}\n\n${identitySection}\n\nThe current situation: ${state.currentEvent?.description ?? ""}`;

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

export function buildPsychologistContext(state: GameState): {
  system: string;
  userMessage: string;
} {
  const system = fillTemplate(PSYCHOLOGIST_SYSTEM_PROMPT, {
    childName: state.childName,
  });

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

  let userMessage = "";
  if (state.identityDocument) {
    userMessage += `## Current Identity Document\n${state.identityDocument}\n\n`;
  }
  userMessage += `## Conversation\n${transcript}\n\nWrite the updated Identity Document for ${state.childName} after this event.`;

  return { system, userMessage };
}

/**
 * Build the landmine section for the world manager prompt from parent confessionals.
 * Returns an empty string when no confessionals are present.
 */
function buildLandmineSection(state: GameState): string {
  const entries: string[] = [];

  const p1 = state.parentPersonalities?.parent1;
  const p2 = state.parentPersonalities?.parent2;

  if (p1?.confessional1) entries.push(`- Parent 1 confessed: "${p1.confessional1}"`);
  if (p1?.confessional2) entries.push(`- Parent 1 confessed: "${p1.confessional2}"`);
  if (p2?.confessional1) entries.push(`- Parent 2 confessed: "${p2.confessional1}"`);
  if (p2?.confessional2) entries.push(`- Parent 2 confessed: "${p2.confessional2}"`);

  if (entries.length === 0) return "";

  return `## Emotional landmines

The parents have revealed things about themselves — fears, wounds, patterns they know are there. These are the places where rational parenting breaks down. Use them to create situations that hit these specific pressure points.

${entries.join("\n")}

Let these surface naturally. Don't announce them. Create events that quietly activate these patterns and watch what the parents do.`;
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
