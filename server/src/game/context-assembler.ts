import type { GameState, Message } from "../types.js";
import {
  KID_SYSTEM_PROMPT,
  PSYCHOLOGIST_SYSTEM_PROMPT,
  WORLD_MANAGER_SYSTEM_PROMPT,
  EPILOGUE_SYSTEM_PROMPT,
  REPORT_CARD_SYSTEM_PROMPT,
} from "../llm/prompts.js";

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

  const system = fillTemplate(KID_SYSTEM_PROMPT, {
    childName: state.childName,
    age: String(state.currentEvent?.age ?? 4),
    identitySection,
    eventDescription: state.currentEvent?.description ?? "",
  });

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

export function buildWorldManagerContext(state: GameState): {
  system: string;
  userMessage: string;
} {
  const previousEvents =
    state.events.length > 0
      ? state.events.map((e) => `- Age ${e.age}: ${e.description}`).join("\n")
      : "No events yet — this is the beginning of the story.";

  const system = fillTemplate(WORLD_MANAGER_SYSTEM_PROMPT, {
    childName: state.childName,
    previousEvents,
    relationshipType: state.relationshipType,
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
  const system = fillTemplate(REPORT_CARD_SYSTEM_PROMPT, {
    childName: state.childName,
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
