# Raising Intelligences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a multiplayer conversational co-parenting game where two players raise an AI child through life events, shaping their personality through conversation.

**Architecture:** Vertical slice milestones — each produces a playable increment. Pure game core (state machine, turn rules, context assembly) separated from I/O (LLM, websockets, DB) behind interfaces. LLM output quality is validated via Langfuse + playtesting, never unit-tested — tests verify that the correct prompt is assembled and that state transitions are correct.

**Tech Stack:** TypeScript throughout. React + Vite (client). Node.js + Express (server). Postgres (pg driver, no ORM). Anthropic SDK (Claude). Langfuse SDK. Socket.io (multiplayer). Vitest (testing).

## Global Constraints

- TypeScript strict mode everywhere
- Node.js 20+
- Mobile-first responsive design — all UI must be thumb-friendly
- No avatars, illustrations, or emoji in UI — typography-driven, black and white with one muted accent color
- All LLM calls use Claude API via `@anthropic-ai/sdk`
- In-memory authoritative state for active games; Postgres write-through for persistence
- Kid's identity document is never shown to players during gameplay

---

## File Structure

```
raising_intelligences/
├── package.json                        # workspace root
├── tsconfig.base.json                  # shared TS config
├── client/
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── global.css
│       ├── components/
│       │   ├── Lobby.tsx
│       │   ├── Chat.tsx
│       │   ├── MessageList.tsx
│       │   ├── MessageInput.tsx
│       │   ├── EventIntro.tsx
│       │   ├── Debrief.tsx
│       │   ├── Endgame.tsx
│       │   └── ReportCard.tsx
│       └── hooks/
│           ├── useGame.ts
│           └── useSocket.ts
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                    # express + socket.io bootstrap
│       ├── types.ts                    # shared type definitions
│       ├── game/
│       │   ├── state-machine.ts        # pure game state transitions
│       │   ├── conversation-engine.ts  # turn mgmt, message caps, debounce
│       │   └── context-assembler.ts    # builds LLM prompts from game state
│       ├── llm/
│       │   ├── client.ts              # LLMClient interface
│       │   ├── claude.ts              # Claude implementation
│       │   ├── mock.ts                # mock for testing
│       │   └── prompts.ts             # system prompt templates
│       ├── db/
│       │   ├── pool.ts                # pg connection pool
│       │   ├── migrate.ts             # migration runner
│       │   ├── migrations/
│       │   │   └── 001-initial.sql
│       │   └── repository.ts          # GameRepository interface + pg impl
│       ├── routes/
│       │   └── game.ts                # HTTP routes (create game, join)
│       ├── socket/
│       │   └── handlers.ts            # socket.io event handlers
│       └── observability/
│           └── langfuse.ts            # Langfuse tracing wrapper
│   └── tests/
│       ├── state-machine.test.ts
│       ├── conversation-engine.test.ts
│       └── context-assembler.test.ts
└── db/
    └── docker-compose.yml              # local postgres
```

---

## Milestone 1: Playable Solo Prototype (DETAILED)

**What you can play:** One player, two hardcoded events, talking to the kid via Claude. After each event, the Psychologist updates the identity doc. The kid feels different in event 2 because of what happened in event 1. At the end, you see the identity doc. This proves the core thesis: conversations shape personality.

No websockets, no second player, no database. React app talks to Express server via HTTP + Server-Sent Events (for streaming kid responses).

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json` (workspace root)
- Create: `tsconfig.base.json`
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/index.ts`
- Create: `server/src/types.ts`
- Create: `client/package.json`
- Create: `client/vite.config.ts`
- Create: `client/index.html`
- Create: `client/src/main.tsx`
- Create: `client/src/App.tsx`
- Create: `client/src/global.css`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: working dev environment — `npm run dev` starts both client (Vite on :5173) and server (Express on :3000) with hot reload

- [ ] **Step 1: Initialize workspace root**

```json
// package.json
{
  "name": "raising-intelligences",
  "private": true,
  "workspaces": ["client", "server"],
  "scripts": {
    "dev": "concurrently \"npm run dev -w server\" \"npm run dev -w client\"",
    "test": "npm run test -w server"
  },
  "devDependencies": {
    "concurrently": "^9.1.0",
    "typescript": "^5.7.0"
  }
}
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 2: Initialize server package**

```json
// server/package.json
{
  "name": "server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "test": "vitest"
  },
  "dependencies": {
    "express": "^5.1.0",
    "cors": "^2.8.5",
    "@anthropic-ai/sdk": "^0.52.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/cors": "^2.8.17",
    "tsx": "^4.19.0",
    "vitest": "^3.2.0",
    "@types/node": "^22.0.0"
  }
}
```

```json
// server/tsconfig.json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

```typescript
// server/src/types.ts
export type GamePhase =
  | "lobby"
  | "event_intro"
  | "family_chat"
  | "sidebar"
  | "processing"
  | "debrief"
  | "epilogue"
  | "adult_chat"
  | "report_card"
  | "ended";

export type ChatType = "shared" | "private" | "debrief";

export type Sender = "parent1" | "parent2" | "kid";

export interface Message {
  sender: Sender;
  content: string;
  chatType: ChatType;
  visibleTo: Sender[];
  timestamp: number;
}

export interface GameEvent {
  eventNumber: number;
  age: number;
  description: string;
  setting: string;
  trigger: string;
}

export interface GameState {
  id: string;
  phase: GamePhase;
  childName: string;
  relationshipType: string;
  currentEvent: GameEvent | null;
  currentEventNumber: number;
  totalEvents: number;
  identityDocument: string;
  identitySnapshots: { eventNumber: number; document: string }[];
  events: GameEvent[];
  messages: Message[];
  parentMessageCount: number;
  sidebarUsed: { parent1: boolean; parent2: boolean };
  sidebarActive: Sender | null;
}

export interface LLMClient {
  generateKidResponse(
    identityDocument: string,
    age: number,
    conversationHistory: Message[],
    eventDescription: string,
    childName: string,
    onChunk: (chunk: string) => void
  ): Promise<string>;

  generateIdentityUpdate(
    currentIdentityDocument: string,
    conversationHistory: Message[],
    eventDescription: string,
    age: number,
    childName: string
  ): Promise<string>;

  generateEvent(
    identityDocument: string,
    previousEvents: GameEvent[],
    childName: string
  ): Promise<GameEvent>;

  generateEpilogue(
    identityDocument: string,
    allEvents: GameEvent[],
    childName: string
  ): Promise<string>;

  generateReportCard(
    identityDocument: string,
    identitySnapshots: { eventNumber: number; document: string }[],
    epilogue: string,
    allMessages: Message[],
    childName: string
  ): Promise<string>;
}
```

```typescript
// server/src/index.ts
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

- [ ] **Step 3: Initialize client package**

```json
// client/package.json
{
  "name": "client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.5.0",
    "vite": "^6.3.0"
  }
}
```

```typescript
// client/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
```

```html
<!-- client/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Raising Intelligences</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```tsx
// client/src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

```tsx
// client/src/App.tsx
export function App() {
  return (
    <div className="app">
      <p>raising intelligences</p>
    </div>
  );
}
```

```css
/* client/src/global.css */
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,300;0,400;0,500;1,300;1,400&display=swap');

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

:root {
  --bg: #0a0a0a;
  --fg: #e8e8e8;
  --fg-dim: #888;
  --accent: #7a6f5d;
  --kid: #c4b99a;
  --font: 'IBM Plex Mono', monospace;
}

body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--fg);
  font-size: 15px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

.app {
  max-width: 600px;
  margin: 0 auto;
  padding: 16px;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}
```

- [ ] **Step 4: Install dependencies and verify**

Run: `npm install`
Expected: installs both workspaces without errors

Run: `npm run dev`
Expected: Vite serves client on :5173, Express serves on :3000, browser shows "raising intelligences"

- [ ] **Step 5: Commit**

```bash
git init
git add package.json tsconfig.base.json client/ server/src/index.ts server/src/types.ts server/package.json server/tsconfig.json
git commit -m "feat: project scaffolding with client and server workspaces"
```

---

### Task 2: Game State Machine

**Files:**
- Create: `server/src/game/state-machine.ts`
- Create: `server/tests/state-machine.test.ts`

**Interfaces:**
- Consumes: `GameState`, `GamePhase`, `Message`, `Sender` from `types.ts`
- Produces: `createGame(childName: string, relationshipType?: string): GameState`, `transition(state: GameState, action: GameAction): GameState`, `canTransition(state: GameState, action: GameAction): boolean`

`GameAction` is a discriminated union:
```typescript
type GameAction =
  | { type: "START_EVENT"; event: GameEvent }
  | { type: "PARENT_MESSAGE"; sender: Sender; content: string }
  | { type: "KID_MESSAGE"; content: string }
  | { type: "START_SIDEBAR"; parent: Sender }
  | { type: "END_SIDEBAR" }
  | { type: "END_FAMILY_CHAT" }
  | { type: "IDENTITY_UPDATED"; document: string }
  | { type: "READY_UP"; player: Sender }
  | { type: "END_DEBRIEF" }
  | { type: "START_EPILOGUE"; epilogue: string }
  | { type: "START_ADULT_CHAT"; event: GameEvent }
  | { type: "SHOW_REPORT_CARD"; reportCard: string }
```

- [ ] **Step 1: Write failing tests for state creation and basic transitions**

```typescript
// server/tests/state-machine.test.ts
import { describe, it, expect } from "vitest";
import { createGame, transition, canTransition } from "../src/game/state-machine.js";
import type { GameEvent } from "../src/types.js";

const testEvent: GameEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child is 4. They broke a vase and are standing over the pieces.",
  setting: "Living room",
  trigger: "Accident while playing",
};

describe("createGame", () => {
  it("creates a game in event_intro phase with empty state", () => {
    const state = createGame("Luna");
    expect(state.childName).toBe("Luna");
    expect(state.phase).toBe("event_intro");
    expect(state.currentEventNumber).toBe(0);
    expect(state.identityDocument).toBe("");
    expect(state.messages).toEqual([]);
    expect(state.parentMessageCount).toBe(0);
  });
});

describe("transition", () => {
  it("START_EVENT moves from event_intro to family_chat", () => {
    const state = createGame("Luna");
    const next = transition(state, { type: "START_EVENT", event: testEvent });
    expect(next.phase).toBe("family_chat");
    expect(next.currentEvent).toEqual(testEvent);
    expect(next.currentEventNumber).toBe(1);
    expect(next.events).toHaveLength(1);
  });

  it("PARENT_MESSAGE adds message and increments count", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, {
      type: "PARENT_MESSAGE",
      sender: "parent1",
      content: "It's okay, accidents happen.",
    });
    expect(state.messages).toHaveLength(1);
    expect(state.parentMessageCount).toBe(1);
    expect(state.messages[0].chatType).toBe("shared");
  });

  it("KID_MESSAGE adds message without incrementing parent count", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, {
      type: "KID_MESSAGE",
      content: "I didn't mean to!",
    });
    expect(state.messages).toHaveLength(1);
    expect(state.parentMessageCount).toBe(0);
  });

  it("tracks parent message count toward cap of 12", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    for (let i = 0; i < 12; i++) {
      state = transition(state, {
        type: "PARENT_MESSAGE",
        sender: i % 2 === 0 ? "parent1" : "parent2",
        content: `message ${i}`,
      });
    }
    expect(state.parentMessageCount).toBe(12);
    expect(
      canTransition(state, {
        type: "PARENT_MESSAGE",
        sender: "parent1",
        content: "one more",
      })
    ).toBe(false);
  });

  it("START_SIDEBAR switches to sidebar phase", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "START_SIDEBAR", parent: "parent1" });
    expect(state.phase).toBe("sidebar");
    expect(state.sidebarActive).toBe("parent1");
    expect(state.sidebarUsed.parent1).toBe(true);
  });

  it("prevents second sidebar for same parent", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "START_SIDEBAR", parent: "parent1" });
    state = transition(state, { type: "END_SIDEBAR" });
    expect(
      canTransition(state, { type: "START_SIDEBAR", parent: "parent1" })
    ).toBe(false);
    expect(
      canTransition(state, { type: "START_SIDEBAR", parent: "parent2" })
    ).toBe(true);
  });

  it("sidebar messages are private to initiating parent", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "START_SIDEBAR", parent: "parent1" });
    state = transition(state, {
      type: "PARENT_MESSAGE",
      sender: "parent1",
      content: "Just between us...",
    });
    const msg = state.messages[state.messages.length - 1];
    expect(msg.chatType).toBe("private");
    expect(msg.visibleTo).toEqual(["parent1", "kid"]);
  });

  it("END_FAMILY_CHAT moves to processing", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    expect(state.phase).toBe("processing");
  });

  it("IDENTITY_UPDATED moves to debrief and snapshots", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    state = transition(state, {
      type: "IDENTITY_UPDATED",
      document: "Core beliefs: the world is safe.",
    });
    expect(state.phase).toBe("debrief");
    expect(state.identityDocument).toBe("Core beliefs: the world is safe.");
    expect(state.identitySnapshots).toHaveLength(1);
    expect(state.identitySnapshots[0].eventNumber).toBe(1);
  });

  it("END_DEBRIEF resets for next event", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    state = transition(state, {
      type: "IDENTITY_UPDATED",
      document: "Core beliefs: the world is safe.",
    });
    state = transition(state, { type: "END_DEBRIEF" });
    expect(state.phase).toBe("event_intro");
    expect(state.parentMessageCount).toBe(0);
    expect(state.sidebarUsed).toEqual({ parent1: false, parent2: false });
    expect(state.sidebarActive).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/state-machine.test.ts`
Expected: FAIL — module `../src/game/state-machine.js` not found

- [ ] **Step 3: Implement the state machine**

```typescript
// server/src/game/state-machine.ts
import type { GameState, GameEvent, Message, Sender, GamePhase } from "../types.js";
import { randomUUID } from "crypto";

const PARENT_MESSAGE_CAP = 12;
const SIDEBAR_MESSAGE_CAP = 12;

export type GameAction =
  | { type: "START_EVENT"; event: GameEvent }
  | { type: "PARENT_MESSAGE"; sender: Sender; content: string }
  | { type: "KID_MESSAGE"; content: string }
  | { type: "START_SIDEBAR"; parent: Sender }
  | { type: "END_SIDEBAR" }
  | { type: "END_FAMILY_CHAT" }
  | { type: "IDENTITY_UPDATED"; document: string }
  | { type: "READY_UP"; player: Sender }
  | { type: "END_DEBRIEF" }
  | { type: "START_EPILOGUE"; epilogue: string }
  | { type: "START_ADULT_CHAT"; event: GameEvent }
  | { type: "SHOW_REPORT_CARD"; reportCard: string };

export function createGame(childName: string, relationshipType = "co-parents"): GameState {
  return {
    id: randomUUID(),
    phase: "event_intro",
    childName,
    relationshipType,
    currentEvent: null,
    currentEventNumber: 0,
    totalEvents: 10,
    identityDocument: "",
    identitySnapshots: [],
    events: [],
    messages: [],
    parentMessageCount: 0,
    sidebarUsed: { parent1: false, parent2: false },
    sidebarActive: null,
  };
}

export function canTransition(state: GameState, action: GameAction): boolean {
  switch (action.type) {
    case "START_EVENT":
      return state.phase === "event_intro";
    case "PARENT_MESSAGE":
      if (state.phase === "sidebar") {
        return state.sidebarActive === action.sender;
      }
      return (
        state.phase === "family_chat" && state.parentMessageCount < PARENT_MESSAGE_CAP
      );
    case "KID_MESSAGE":
      return state.phase === "family_chat" || state.phase === "sidebar" || state.phase === "adult_chat";
    case "START_SIDEBAR":
      return (
        state.phase === "family_chat" &&
        state.sidebarActive === null &&
        !state.sidebarUsed[action.parent as "parent1" | "parent2"]
      );
    case "END_SIDEBAR":
      return state.phase === "sidebar";
    case "END_FAMILY_CHAT":
      return state.phase === "family_chat";
    case "IDENTITY_UPDATED":
      return state.phase === "processing";
    case "END_DEBRIEF":
      return state.phase === "debrief";
    case "START_EPILOGUE":
      return state.phase === "event_intro";
    case "START_ADULT_CHAT":
      return state.phase === "epilogue" || state.phase === "event_intro";
    case "SHOW_REPORT_CARD":
      return state.phase === "event_intro" || state.phase === "epilogue";
    default:
      return false;
  }
}

export function transition(state: GameState, action: GameAction): GameState {
  if (!canTransition(state, action)) {
    throw new Error(
      `Invalid transition: ${action.type} from phase ${state.phase}`
    );
  }

  switch (action.type) {
    case "START_EVENT":
      return {
        ...state,
        phase: "family_chat",
        currentEvent: action.event,
        currentEventNumber: state.currentEventNumber + 1,
        events: [...state.events, action.event],
      };

    case "PARENT_MESSAGE": {
      const chatType = state.phase === "sidebar" ? "private" as const : "shared" as const;
      const visibleTo: Sender[] =
        chatType === "private"
          ? [action.sender, "kid"]
          : ["parent1", "parent2", "kid"];
      const message: Message = {
        sender: action.sender,
        content: action.content,
        chatType,
        visibleTo,
        timestamp: Date.now(),
      };
      return {
        ...state,
        messages: [...state.messages, message],
        parentMessageCount: state.parentMessageCount + 1,
      };
    }

    case "KID_MESSAGE": {
      const kidChatType = state.phase === "sidebar" ? "private" as const : "shared" as const;
      const kidVisibleTo: Sender[] =
        state.phase === "sidebar" && state.sidebarActive
          ? [state.sidebarActive, "kid"]
          : ["parent1", "parent2", "kid"];
      const kidMessage: Message = {
        sender: "kid",
        content: action.content,
        chatType: kidChatType,
        visibleTo: kidVisibleTo,
        timestamp: Date.now(),
      };
      return {
        ...state,
        messages: [...state.messages, kidMessage],
      };
    }

    case "START_SIDEBAR":
      return {
        ...state,
        phase: "sidebar",
        sidebarActive: action.parent,
        sidebarUsed: {
          ...state.sidebarUsed,
          [action.parent]: true,
        },
      };

    case "END_SIDEBAR":
      return {
        ...state,
        phase: "family_chat",
        sidebarActive: null,
      };

    case "END_FAMILY_CHAT":
      return {
        ...state,
        phase: "processing",
      };

    case "IDENTITY_UPDATED":
      return {
        ...state,
        phase: "debrief",
        identityDocument: action.document,
        identitySnapshots: [
          ...state.identitySnapshots,
          {
            eventNumber: state.currentEventNumber,
            document: action.document,
          },
        ],
      };

    case "END_DEBRIEF":
      return {
        ...state,
        phase: "event_intro",
        currentEvent: null,
        parentMessageCount: 0,
        sidebarUsed: { parent1: false, parent2: false },
        sidebarActive: null,
      };

    case "START_EPILOGUE":
      return {
        ...state,
        phase: "epilogue",
      };

    case "START_ADULT_CHAT":
      return {
        ...state,
        phase: "adult_chat",
        currentEvent: action.event,
        parentMessageCount: 0,
      };

    case "SHOW_REPORT_CARD":
      return {
        ...state,
        phase: "report_card",
      };

    default:
      return state;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/state-machine.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/game/state-machine.ts server/tests/state-machine.test.ts
git commit -m "feat: game state machine with transitions, message caps, and sidebar rules"
```

---

### Task 3: System Prompts & Context Assembler

**Files:**
- Create: `server/src/llm/prompts.ts`
- Create: `server/src/game/context-assembler.ts`
- Create: `server/tests/context-assembler.test.ts`

**Interfaces:**
- Consumes: `GameState`, `Message`, `GameEvent` from `types.ts`
- Produces:
  - `buildKidContext(state: GameState): { system: string; messages: Array<{role: string; content: string}> }`
  - `buildPsychologistContext(state: GameState): { system: string; userMessage: string }`
  - `buildWorldManagerContext(state: GameState): { system: string; userMessage: string }`
  - `buildEpilogueContext(state: GameState): { system: string; userMessage: string }`
  - `buildReportCardContext(state: GameState, epilogue: string): { system: string; userMessage: string }`

- [ ] **Step 1: Write the system prompt templates**

```typescript
// server/src/llm/prompts.ts

export const KID_SYSTEM_PROMPT = `You are {childName}, a {age}-year-old child. You are talking to your parents.

You are not aware that you are in a game or that you are played by an AI. You are simply a child. Behave exactly as a real {age}-year-old would:
- Use vocabulary and sentence structure appropriate for your age
- Have age-appropriate emotional responses and understanding
- Be capable of age-appropriate mischief, curiosity, stubbornness, sweetness
- Don't always comply with what your parents say — real kids push back, change subjects, get distracted
- You can initiate topics, ask questions, express needs
- Show your emotions through behavior, not by narrating them

{identitySection}

The current situation: {eventDescription}

Keep your responses short — 1-3 sentences for a young child, up to a short paragraph for a teenager. Never break character. You are {childName}.`;

export const PSYCHOLOGIST_SYSTEM_PROMPT = `You are the Psychologist — an internal narrator tracking the psychological development of a child named {childName}.

After each life event, you read the full conversation between the child and their parents and update the child's Identity Document — a living psychological portrait written in the child's internal voice.

The Identity Document has these sections:
- **Core beliefs** — What the child believes about the world, themselves, and other people
- **Inner voices** — What each parent's influence sounds like in their head, and how those voices interact
- **Memories that stuck** — Specific moments that formed lasting impressions (not a transcript)
- **Emotional patterns** — How the child reacts to stress, conflict, praise, failure
- **Self-image** — How the child sees themselves
- **Relationships** — How the child relates to each parent

Guidelines:
- Write in the child's internal voice, not clinical language. A 6-year-old's identity document sounds different from a 14-year-old's.
- Be lossy on purpose. Not everything lands. Some things parents say don't register at all.
- Preserve contradictions — if parents gave conflicting messages, hold both: "Part of me thinks X, but part of me thinks Y."
- Compress older material when newer experiences recontextualize them, but keep the most formative memories.
- The document should grow but stay bounded — aim for 300-500 words total.

You must output ONLY the updated Identity Document. No commentary, no preamble.`;

export const WORLD_MANAGER_SYSTEM_PROMPT = `You are the World Manager for a childhood story about {childName}. You generate the next life event based on who this child is becoming and how their parents have been raising them.

The parents' relationship: {relationshipType}. This shapes the family dynamic and the kinds of events that make sense. Two romantic partners raising a child together will face different situations than two friends, siblings, or ex-partners co-parenting.

Your events should be:
- A mix of mundane-but-formative (first day of school, caught lying, failing a test) and high-drama (divorce, loss, major conflict)
- Natural consequences of the parenting dynamics you observe. Contradictory parents might trigger a separation. Overprotective parents might generate a "kid unsupervised for the first time" event.
- Age-appropriate and plausible
- Rich enough to provoke different parenting responses

A typical childhood arc covers ages 3-18 with a mix of everyday moments and turning points.

Events covered so far:
{previousEvents}

You must respond with a JSON object with these exact fields:
{
  "eventNumber": <next number>,
  "age": <child's age for this event>,
  "description": "<vivid 1-2 sentence description of the situation, addressed to the parents as 'your child'>",
  "setting": "<where this takes place>",
  "trigger": "<what caused this event>"
}`;

export const EPILOGUE_SYSTEM_PROMPT = `You are the narrator of {childName}'s adult life. Based on their identity document — the full record of who they became through childhood — write a narrative of their early adulthood (ages 18-25).

This is a story, not a list of outcomes. Write about:
- Where they went and what they chose
- How they handle conflict and adversity
- What they're afraid of and what makes them come alive
- How the voices of their parents echo in their decisions
- Their relationships — romantic, friendships, professional

Use specific details. Reference their actual memories and beliefs from the identity document. Show how childhood patterns play out in adult contexts.

Write 3-4 paragraphs. Prose, not bullet points. Present tense.`;

export const REPORT_CARD_SYSTEM_PROMPT = `You are generating the final Report Card for {childName}'s upbringing. Based on the full identity document, epilogue, and conversation history, produce a structured assessment.

Format your response as follows:

# {childName}

## Personality
[3-5 key traits, each with a one-sentence description]

## Strengths
[2-3 things they're good at or that serve them well]

## Struggles
[2-3 things they find hard or that hold them back]

## Pivotal Moments
[3-4 specific events that shaped them most, with one sentence on why each mattered]

## The Voices in Their Head
### [Parent 1's name]
[What this parent's lasting influence sounds like — a sentence or two the child hears in their head]

### [Parent 2's name]
[What this parent's lasting influence sounds like]

## Notable Quotes That Stuck
[3-5 direct quotes from the parents that became part of the child's inner world, with brief context]

Be specific. Reference actual events and conversations. This is the artifact players keep — make it feel true.`;
```

- [ ] **Step 2: Write failing tests for context assembler**

```typescript
// server/tests/context-assembler.test.ts
import { describe, it, expect } from "vitest";
import { buildKidContext, buildPsychologistContext } from "../src/game/context-assembler.js";
import { createGame, transition } from "../src/game/state-machine.js";
import type { GameEvent } from "../src/types.js";

const testEvent: GameEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child is 4. They broke a vase and are standing over the pieces.",
  setting: "Living room",
  trigger: "Accident while playing",
};

describe("buildKidContext", () => {
  it("includes child name, age, and event in system prompt", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    const ctx = buildKidContext(state);
    expect(ctx.system).toContain("Luna");
    expect(ctx.system).toContain("4-year-old");
    expect(ctx.system).toContain("broke a vase");
  });

  it("includes identity document when present", () => {
    let state = createGame("Luna");
    state.identityDocument = "Core beliefs: the world is safe.";
    state = transition(state, { type: "START_EVENT", event: testEvent });
    const ctx = buildKidContext(state);
    expect(ctx.system).toContain("Core beliefs: the world is safe.");
  });

  it("formats conversation history as messages array", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, {
      type: "PARENT_MESSAGE",
      sender: "parent1",
      content: "It's okay, accidents happen.",
    });
    state = transition(state, {
      type: "KID_MESSAGE",
      content: "I didn't mean to!",
    });
    const ctx = buildKidContext(state);
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0]).toEqual({ role: "user", content: "Parent 1: It's okay, accidents happen." });
    expect(ctx.messages[1]).toEqual({ role: "assistant", content: "I didn't mean to!" });
  });

  it("only includes messages visible to the kid in current chat context", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, {
      type: "PARENT_MESSAGE",
      sender: "parent1",
      content: "shared message",
    });
    // Simulate a sidebar message from parent2 that kid shouldn't see in shared context
    // (sidebar messages are visible to kid but only during the sidebar)
    const ctx = buildKidContext(state);
    expect(ctx.messages).toHaveLength(1);
  });
});

describe("buildPsychologistContext", () => {
  it("includes all messages from the event including private sidebars", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, {
      type: "PARENT_MESSAGE",
      sender: "parent1",
      content: "shared message",
    });
    state = transition(state, { type: "START_SIDEBAR", parent: "parent2" });
    state = transition(state, {
      type: "PARENT_MESSAGE",
      sender: "parent2",
      content: "private message",
    });
    state = transition(state, { type: "END_SIDEBAR" });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    const ctx = buildPsychologistContext(state);
    expect(ctx.userMessage).toContain("shared message");
    expect(ctx.userMessage).toContain("private message");
    expect(ctx.userMessage).toContain("[Private conversation with Parent 2]");
  });

  it("includes current identity document for incremental update", () => {
    let state = createGame("Luna");
    state.identityDocument = "Core beliefs: the world is safe.";
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    const ctx = buildPsychologistContext(state);
    expect(ctx.userMessage).toContain("Core beliefs: the world is safe.");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/context-assembler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement the context assembler**

```typescript
// server/src/game/context-assembler.ts
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
      return m.chatType === "private" && m.visibleTo.includes(sidebarParent!);
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
    if (m.chatType === "private" && currentSection !== `private-${m.visibleTo.find((v) => v !== "kid")}`) {
      const privatParent = m.visibleTo.find((v) => v !== "kid")!;
      currentSection = `private-${privatParent}`;
      transcript += `\n[Private conversation with ${senderLabel(privatParent)}]\n`;
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
  const previousEvents = state.events.length > 0
    ? state.events
        .map((e) => `- Age ${e.age}: ${e.description}`)
        .join("\n")
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/context-assembler.test.ts`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/llm/prompts.ts server/src/game/context-assembler.ts server/tests/context-assembler.test.ts
git commit -m "feat: system prompts and context assembler for all three LLM roles"
```

---

### Task 4: LLM Client (Claude Implementation)

**Files:**
- Create: `server/src/llm/client.ts`
- Create: `server/src/llm/claude.ts`
- Create: `server/src/llm/mock.ts`

**Interfaces:**
- Consumes: `LLMClient` interface from `types.ts`
- Produces: `ClaudeLLMClient` (class implementing `LLMClient`), `MockLLMClient` (for tests)

- [ ] **Step 1: Implement the Claude LLM client**

```typescript
// server/src/llm/claude.ts
import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, GameEvent } from "../types.js";

export class ClaudeLLMClient implements LLMClient {
  private client: Anthropic;
  private model = "claude-sonnet-4-20250514";

  constructor() {
    this.client = new Anthropic();
  }

  async generateKidResponse(
    identityDocument: string,
    age: number,
    conversationHistory: Array<{ role: string; content: string }>,
    eventDescription: string,
    childName: string,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    const { buildKidContext } = await import("../game/context-assembler.js");
    // We receive pre-built context from the caller, but for streaming we call the API directly
    const messages = conversationHistory.length > 0
      ? conversationHistory.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }))
      : [{ role: "user" as const, content: "(The child looks at their parents, waiting.)" }];

    let fullResponse = "";

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 300,
      system: arguments[0], // system prompt passed as first positional
      messages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        fullResponse += event.delta.text;
        onChunk(event.delta.text);
      }
    }

    return fullResponse;
  }

  async generateIdentityUpdate(
    currentIdentityDocument: string,
    conversationHistory: Array<{ role: string; content: string }>,
    eventDescription: string,
    age: number,
    childName: string
  ): Promise<string> {
    // This method receives pre-built system + userMessage from the conversation engine
    throw new Error("Use generateWithContext instead");
  }

  async generateEvent(
    identityDocument: string,
    previousEvents: GameEvent[],
    childName: string
  ): Promise<GameEvent> {
    throw new Error("Use generateWithContext instead");
  }

  async generateEpilogue(
    identityDocument: string,
    allEvents: GameEvent[],
    childName: string
  ): Promise<string> {
    throw new Error("Use generateWithContext instead");
  }

  async generateReportCard(
    identityDocument: string,
    identitySnapshots: Array<{ eventNumber: number; document: string }>,
    epilogue: string,
    allMessages: Array<{ sender: string; content: string }>,
    childName: string
  ): Promise<string> {
    throw new Error("Use generateWithContext instead");
  }

  async streamResponse(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    let fullResponse = "";

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 500,
      system,
      messages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        fullResponse += event.delta.text;
        onChunk(event.delta.text);
      }
    }

    return fullResponse;
  }

  async completeResponse(
    system: string,
    userMessage: string,
    maxTokens = 1500
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = response.content[0];
    if (block.type === "text") return block.text;
    throw new Error("Unexpected response type");
  }

  async completeJson<T>(
    system: string,
    userMessage: string
  ): Promise<T> {
    const text = await this.completeResponse(system, userMessage, 500);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    return JSON.parse(jsonMatch[0]) as T;
  }
}
```

- [ ] **Step 2: Implement the mock client for testing**

```typescript
// server/src/llm/mock.ts
import type { GameEvent } from "../types.js";

export class MockLLMClient {
  public kidResponses: string[] = ["I didn't mean to!"];
  public identityUpdates: string[] = ["Core beliefs: the world is safe."];
  public events: GameEvent[] = [];
  public epilogueText = "They grew up to be thoughtful.";
  public reportCardText = "# Luna\n## Personality\nThoughtful and kind.";
  private kidCallCount = 0;
  private identityCallCount = 0;

  async streamResponse(
    _system: string,
    _messages: Array<{ role: string; content: string }>,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    const response = this.kidResponses[this.kidCallCount % this.kidResponses.length];
    this.kidCallCount++;
    for (const char of response) {
      onChunk(char);
    }
    return response;
  }

  async completeResponse(
    _system: string,
    _userMessage: string
  ): Promise<string> {
    const response = this.identityUpdates[this.identityCallCount % this.identityUpdates.length];
    this.identityCallCount++;
    return response;
  }

  async completeJson<T>(
    _system: string,
    _userMessage: string
  ): Promise<T> {
    const event = this.events.shift();
    if (!event) throw new Error("No mock events available");
    return event as unknown as T;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add server/src/llm/claude.ts server/src/llm/mock.ts
git commit -m "feat: Claude LLM client with streaming and mock for testing"
```

---

### Task 5: Conversation Engine

**Files:**
- Create: `server/src/game/conversation-engine.ts`
- Create: `server/tests/conversation-engine.test.ts`

**Interfaces:**
- Consumes: `GameState` from `types.ts`, `transition`/`canTransition` from `state-machine.ts`, `buildKidContext`/`buildPsychologistContext` from `context-assembler.ts`, `MockLLMClient`/`ClaudeLLMClient`
- Produces: `ConversationEngine` class with methods:
  - `constructor(llm: { streamResponse, completeResponse, completeJson })`
  - `startEvent(state: GameState): Promise<GameState>` — generates event via World Manager, transitions state
  - `handleParentMessage(state: GameState, sender: Sender, content: string): Promise<{state: GameState, kidResponse: string}>` — adds parent message, triggers kid response, returns updated state
  - `startSidebar(state: GameState, parent: Sender): GameState`
  - `endSidebar(state: GameState): GameState`
  - `endFamilyChat(state: GameState): Promise<GameState>` — triggers Psychologist, updates identity doc
  - `getMessageCapRemaining(state: GameState): number`

- [ ] **Step 1: Write failing tests**

```typescript
// server/tests/conversation-engine.test.ts
import { describe, it, expect } from "vitest";
import { ConversationEngine } from "../src/game/conversation-engine.js";
import { createGame } from "../src/game/state-machine.js";
import { MockLLMClient } from "../src/llm/mock.js";
import type { GameEvent } from "../src/types.js";

const testEvent: GameEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child is 4. They broke a vase.",
  setting: "Living room",
  trigger: "Accident",
};

describe("ConversationEngine", () => {
  it("startEvent generates event and transitions to family_chat", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    const engine = new ConversationEngine(mock);
    const state = createGame("Luna");
    const next = await engine.startEvent(state);
    expect(next.phase).toBe("family_chat");
    expect(next.currentEvent?.description).toContain("broke a vase");
  });

  it("handleParentMessage adds message and gets kid response", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["I'm sorry!"];
    const engine = new ConversationEngine(mock);
    let state = createGame("Luna");
    state = await engine.startEvent(state);
    const result = await engine.handleParentMessage(state, "parent1", "What happened?");
    expect(result.state.messages).toHaveLength(2);
    expect(result.state.messages[0].content).toBe("What happened?");
    expect(result.state.messages[1].content).toBe("I'm sorry!");
    expect(result.kidResponse).toBe("I'm sorry!");
  });

  it("endFamilyChat triggers psychologist and updates identity doc", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["I'm sorry!"];
    mock.identityUpdates = ["Core beliefs: accidents are forgivable."];
    const engine = new ConversationEngine(mock);
    let state = createGame("Luna");
    state = await engine.startEvent(state);
    const result = await engine.handleParentMessage(state, "parent1", "It's okay.");
    state = await engine.endFamilyChat(result.state);
    expect(state.phase).toBe("debrief");
    expect(state.identityDocument).toBe("Core beliefs: accidents are forgivable.");
    expect(state.identitySnapshots).toHaveLength(1);
  });

  it("getMessageCapRemaining returns correct count", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["ok"];
    const engine = new ConversationEngine(mock);
    let state = createGame("Luna");
    state = await engine.startEvent(state);
    expect(engine.getMessageCapRemaining(state)).toBe(12);
    const result = await engine.handleParentMessage(state, "parent1", "hi");
    expect(engine.getMessageCapRemaining(result.state)).toBe(11);
  });

  it("sidebar messages use private context for kid responses", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["okay parent", "our secret"];
    const engine = new ConversationEngine(mock);
    let state = createGame("Luna");
    state = await engine.startEvent(state);
    state = engine.startSidebar(state, "parent1");
    const result = await engine.handleParentMessage(state, "parent1", "Just between us");
    expect(result.state.messages[0].chatType).toBe("private");
    expect(result.state.messages[0].visibleTo).toEqual(["parent1", "kid"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/conversation-engine.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the conversation engine**

```typescript
// server/src/game/conversation-engine.ts
import type { GameState, GameEvent, Sender } from "../types.js";
import { transition, canTransition } from "./state-machine.js";
import { buildKidContext, buildPsychologistContext, buildWorldManagerContext } from "./context-assembler.js";

const PARENT_MESSAGE_CAP = 12;

interface LLM {
  streamResponse(
    system: string,
    messages: Array<{ role: string; content: string }>,
    onChunk: (chunk: string) => void
  ): Promise<string>;
  completeResponse(system: string, userMessage: string): Promise<string>;
  completeJson<T>(system: string, userMessage: string): Promise<T>;
}

export class ConversationEngine {
  constructor(private llm: LLM) {}

  async startEvent(state: GameState): Promise<GameState> {
    const ctx = buildWorldManagerContext(state);
    const event = await this.llm.completeJson<GameEvent>(ctx.system, ctx.userMessage);
    return transition(state, { type: "START_EVENT", event });
  }

  async handleParentMessage(
    state: GameState,
    sender: Sender,
    content: string,
    onKidChunk?: (chunk: string) => void
  ): Promise<{ state: GameState; kidResponse: string }> {
    let next = transition(state, { type: "PARENT_MESSAGE", sender, content });

    const ctx = buildKidContext(next);
    const kidResponse = await this.llm.streamResponse(
      ctx.system,
      ctx.messages as Array<{ role: "user" | "assistant"; content: string }>,
      onKidChunk ?? (() => {})
    );

    next = transition(next, { type: "KID_MESSAGE", content: kidResponse });
    return { state: next, kidResponse };
  }

  startSidebar(state: GameState, parent: Sender): GameState {
    return transition(state, { type: "START_SIDEBAR", parent });
  }

  endSidebar(state: GameState): GameState {
    return transition(state, { type: "END_SIDEBAR" });
  }

  async endFamilyChat(state: GameState): Promise<GameState> {
    let next = transition(state, { type: "END_FAMILY_CHAT" });
    const ctx = buildPsychologistContext(next);
    const updatedDoc = await this.llm.completeResponse(ctx.system, ctx.userMessage);
    next = transition(next, { type: "IDENTITY_UPDATED", document: updatedDoc });
    return next;
  }

  endDebrief(state: GameState): GameState {
    return transition(state, { type: "END_DEBRIEF" });
  }

  getMessageCapRemaining(state: GameState): number {
    return PARENT_MESSAGE_CAP - state.parentMessageCount;
  }

  isAtMessageCap(state: GameState): boolean {
    return state.parentMessageCount >= PARENT_MESSAGE_CAP;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/conversation-engine.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/game/conversation-engine.ts server/tests/conversation-engine.test.ts
git commit -m "feat: conversation engine with turn management and kid response generation"
```

---

### Task 6: HTTP API for Solo Prototype

**Files:**
- Create: `server/src/routes/game.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `ConversationEngine`, `ClaudeLLMClient`, `createGame` from `state-machine.ts`
- Produces: HTTP endpoints:
  - `POST /api/game` — creates a new game, returns game ID
  - `POST /api/game/:id/message` — sends a parent message, returns SSE stream of kid response
  - `POST /api/game/:id/end-chat` — ends family chat, triggers psychologist
  - `POST /api/game/:id/end-debrief` — ends debrief, moves to next event
  - `GET /api/game/:id/state` — returns current game state (sans identity doc)
  - `POST /api/game/:id/next-event` — generates and starts the next event

- [ ] **Step 1: Implement game routes**

```typescript
// server/src/routes/game.ts
import { Router } from "express";
import type { Request, Response } from "express";
import { ConversationEngine } from "../game/conversation-engine.js";
import { createGame } from "../game/state-machine.js";
import type { GameState, Sender } from "../types.js";

const games = new Map<string, GameState>();

export function createGameRoutes(engine: ConversationEngine): Router {
  const router = Router();

  router.post("/game", (_req: Request, res: Response) => {
    const { childName, relationshipType } = _req.body as { childName: string; relationshipType?: string };
    if (!childName) {
      res.status(400).json({ error: "childName is required" });
      return;
    }
    const state = createGame(childName, relationshipType);
    games.set(state.id, state);
    res.json({ gameId: state.id });
  });

  router.get("/game/:id/state", (req: Request, res: Response) => {
    const state = games.get(req.params.id);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    const { identityDocument, identitySnapshots, ...publicState } = state;
    res.json(publicState);
  });

  router.post("/game/:id/next-event", async (req: Request, res: Response) => {
    const state = games.get(req.params.id);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    try {
      const next = await engine.startEvent(state);
      games.set(next.id, next);
      res.json({ event: next.currentEvent, phase: next.phase });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/game/:id/message", async (req: Request, res: Response) => {
    const state = games.get(req.params.id);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    const { sender, content } = req.body as { sender: Sender; content: string };

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      const result = await engine.handleParentMessage(
        state,
        sender,
        content,
        (chunk) => {
          res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`);
        }
      );
      games.set(result.state.id, result.state);
      res.write(
        `data: ${JSON.stringify({
          type: "done",
          kidResponse: result.kidResponse,
          messagesRemaining: engine.getMessageCapRemaining(result.state),
        })}\n\n`
      );
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: "error", error: String(err) })}\n\n`);
      res.end();
    }
  });

  router.post("/game/:id/end-chat", async (req: Request, res: Response) => {
    const state = games.get(req.params.id);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    try {
      const next = await engine.endFamilyChat(state);
      games.set(next.id, next);
      res.json({ phase: next.phase });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/game/:id/end-debrief", (req: Request, res: Response) => {
    const state = games.get(req.params.id);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    const next = engine.endDebrief(state);
    games.set(next.id, next);
    res.json({ phase: next.phase });
  });

  return router;
}
```

- [ ] **Step 2: Wire routes into server**

```typescript
// server/src/index.ts — replace full file
import express from "express";
import cors from "cors";
import { createGameRoutes } from "./routes/game.js";
import { ConversationEngine } from "./game/conversation-engine.js";
import { ClaudeLLMClient } from "./llm/claude.js";

const app = express();
app.use(cors());
app.use(express.json());

const llm = new ClaudeLLMClient();
const engine = new ConversationEngine(llm);

app.use("/api", createGameRoutes(engine));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

- [ ] **Step 3: Verify server starts without errors**

Run: `ANTHROPIC_API_KEY=test npm run dev -w server`
Expected: "Server running on port 3000" (will fail on actual API calls without a real key, but boots cleanly)

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/game.ts server/src/index.ts
git commit -m "feat: HTTP API with SSE streaming for solo prototype"
```

---

### Task 7: React Chat UI

**Files:**
- Create: `client/src/components/EventIntro.tsx`
- Create: `client/src/components/MessageList.tsx`
- Create: `client/src/components/MessageInput.tsx`
- Create: `client/src/components/Chat.tsx`
- Create: `client/src/hooks/useGame.ts`
- Modify: `client/src/App.tsx`

**Interfaces:**
- Consumes: HTTP API from Task 6
- Produces: playable single-player UI — name a child, play through events, see messages stream in

- [ ] **Step 1: Build the useGame hook (game state + API calls)**

```typescript
// client/src/hooks/useGame.ts
import { useState, useCallback } from "react";

interface GameEvent {
  eventNumber: number;
  age: number;
  description: string;
  setting: string;
  trigger: string;
}

interface Message {
  sender: string;
  content: string;
  chatType: string;
}

interface GameState {
  phase: string;
  childName: string;
  relationshipType: string;
  currentEvent: GameEvent | null;
  currentEventNumber: number;
  messages: Message[];
  parentMessageCount: number;
}

const API = "/api";

export function useGame() {
  const [gameId, setGameId] = useState<string | null>(null);
  const [phase, setPhase] = useState<string>("start");
  const [childName, setChildName] = useState("");
  const [currentEvent, setCurrentEvent] = useState<GameEvent | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesRemaining, setMessagesRemaining] = useState(12);
  const [streamingMessage, setStreamingMessage] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const createGame = useCallback(async (name: string, relationshipType = "co-parents") => {
    const res = await fetch(`${API}/game`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ childName: name, relationshipType }),
    });
    const data = await res.json();
    setGameId(data.gameId);
    setChildName(name);
    setPhase("event_intro");
    return data.gameId;
  }, []);

  const nextEvent = useCallback(async () => {
    if (!gameId) return;
    const res = await fetch(`${API}/game/${gameId}/next-event`, {
      method: "POST",
    });
    const data = await res.json();
    setCurrentEvent(data.event);
    setPhase(data.phase);
    setMessages([]);
    setMessagesRemaining(12);
  }, [gameId]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!gameId || isStreaming) return;

      setMessages((prev) => [
        ...prev,
        { sender: "parent1", content, chatType: "shared" },
      ]);
      setIsStreaming(true);
      setStreamingMessage("");

      const res = await fetch(`${API}/game/${gameId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: "parent1", content }),
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let kidMessage = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (data.type === "chunk") {
              kidMessage += data.text;
              setStreamingMessage(kidMessage);
            } else if (data.type === "done") {
              setMessages((prev) => [
                ...prev,
                { sender: "kid", content: data.kidResponse, chatType: "shared" },
              ]);
              setStreamingMessage("");
              setMessagesRemaining(data.messagesRemaining);
            }
          }
        }
      }
      setIsStreaming(false);
    },
    [gameId, isStreaming]
  );

  const endChat = useCallback(async () => {
    if (!gameId) return;
    setPhase("processing");
    const res = await fetch(`${API}/game/${gameId}/end-chat`, {
      method: "POST",
    });
    const data = await res.json();
    setPhase(data.phase);
  }, [gameId]);

  const endDebrief = useCallback(async () => {
    if (!gameId) return;
    const res = await fetch(`${API}/game/${gameId}/end-debrief`, {
      method: "POST",
    });
    const data = await res.json();
    setPhase(data.phase);
    setCurrentEvent(null);
  }, [gameId]);

  return {
    phase,
    childName,
    currentEvent,
    messages,
    messagesRemaining,
    streamingMessage,
    isStreaming,
    createGame,
    nextEvent,
    sendMessage,
    endChat,
    endDebrief,
  };
}
```

- [ ] **Step 2: Build the UI components**

```tsx
// client/src/components/EventIntro.tsx
interface Props {
  event: { age: number; description: string } | null;
  onReady: () => void;
  waiting: boolean;
}

export function EventIntro({ event, onReady, waiting }: Props) {
  if (waiting) {
    return (
      <div className="event-intro">
        <p className="dim">generating next event...</p>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="event-intro">
        <button onClick={onReady} className="btn">begin</button>
      </div>
    );
  }

  return (
    <div className="event-intro">
      <p className="age-marker">— age {event.age} —</p>
      <p className="event-description">{event.description}</p>
      <button onClick={onReady} className="btn">enter</button>
    </div>
  );
}
```

```tsx
// client/src/components/MessageList.tsx
interface Message {
  sender: string;
  content: string;
  chatType: string;
}

interface Props {
  messages: Message[];
  streamingMessage: string;
  childName: string;
}

export function MessageList({ messages, streamingMessage, childName }: Props) {
  return (
    <div className="message-list">
      {messages.map((msg, i) => (
        <div key={i} className={`message message-${msg.sender}`}>
          <span className="message-sender">
            {msg.sender === "kid" ? childName : "you"}
          </span>
          <span className="message-content">{msg.content}</span>
        </div>
      ))}
      {streamingMessage && (
        <div className="message message-kid">
          <span className="message-sender">{childName}</span>
          <span className="message-content">{streamingMessage}</span>
        </div>
      )}
    </div>
  );
}
```

```tsx
// client/src/components/MessageInput.tsx
import { useState, type FormEvent } from "react";

interface Props {
  onSend: (content: string) => void;
  disabled: boolean;
  messagesRemaining: number;
}

export function MessageInput({ onSend, disabled, messagesRemaining }: Props) {
  const [text, setText] = useState("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || disabled) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <form onSubmit={handleSubmit} className="message-input">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          messagesRemaining <= 0
            ? "no more messages this scene"
            : `${messagesRemaining} messages left`
        }
        disabled={disabled || messagesRemaining <= 0}
        autoFocus
      />
      <button type="submit" disabled={disabled || !text.trim() || messagesRemaining <= 0}>
        send
      </button>
    </form>
  );
}
```

```tsx
// client/src/components/Chat.tsx
import { MessageList } from "./MessageList";
import { MessageInput } from "./MessageInput";

interface Message {
  sender: string;
  content: string;
  chatType: string;
}

interface Props {
  messages: Message[];
  streamingMessage: string;
  childName: string;
  messagesRemaining: number;
  isStreaming: boolean;
  onSend: (content: string) => void;
  onEndChat: () => void;
}

export function Chat({
  messages,
  streamingMessage,
  childName,
  messagesRemaining,
  isStreaming,
  onSend,
  onEndChat,
}: Props) {
  return (
    <div className="chat">
      <MessageList
        messages={messages}
        streamingMessage={streamingMessage}
        childName={childName}
      />
      <MessageInput
        onSend={onSend}
        disabled={isStreaming}
        messagesRemaining={messagesRemaining}
      />
      <button
        onClick={onEndChat}
        disabled={isStreaming}
        className="btn btn-secondary"
      >
        end conversation
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Wire into App.tsx**

```tsx
// client/src/App.tsx
import { useState } from "react";
import { useGame } from "./hooks/useGame";
import { EventIntro } from "./components/EventIntro";
import { Chat } from "./components/Chat";

export function App() {
  const {
    phase,
    childName,
    currentEvent,
    messages,
    messagesRemaining,
    streamingMessage,
    isStreaming,
    createGame,
    nextEvent,
    sendMessage,
    endChat,
    endDebrief,
  } = useGame();

  const [nameInput, setNameInput] = useState("");
  const [relationshipInput, setRelationshipInput] = useState("romantic partners");
  const [loadingEvent, setLoadingEvent] = useState(false);

  const RELATIONSHIP_OPTIONS = [
    "romantic partners",
    "friends",
    "siblings",
    "ex-partners",
    "co-parents who were never together",
  ];

  const handleStart = async () => {
    if (!nameInput.trim()) return;
    await createGame(nameInput.trim(), relationshipInput);
  };

  const handleNextEvent = async () => {
    setLoadingEvent(true);
    await nextEvent();
    setLoadingEvent(false);
  };

  if (phase === "start") {
    return (
      <div className="app">
        <div className="start-screen">
          <h1>raising intelligences</h1>
          <p className="dim">name your child</p>
          <form onSubmit={(e) => { e.preventDefault(); handleStart(); }}>
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              autoFocus
              className="name-input"
            />
            <p className="dim" style={{ marginTop: "24px" }}>your relationship</p>
            <select
              value={relationshipInput}
              onChange={(e) => setRelationshipInput(e.target.value)}
              className="relationship-select"
            >
              {RELATIONSHIP_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
            <button type="submit" className="btn" disabled={!nameInput.trim()}>
              begin
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (phase === "event_intro") {
    return (
      <div className="app">
        <EventIntro
          event={currentEvent}
          onReady={handleNextEvent}
          waiting={loadingEvent}
        />
      </div>
    );
  }

  if (phase === "family_chat") {
    return (
      <div className="app">
        <p className="age-marker">— age {currentEvent?.age} —</p>
        <Chat
          messages={messages}
          streamingMessage={streamingMessage}
          childName={childName}
          messagesRemaining={messagesRemaining}
          isStreaming={isStreaming}
          onSend={sendMessage}
          onEndChat={endChat}
        />
      </div>
    );
  }

  if (phase === "processing") {
    return (
      <div className="app">
        <p className="dim">time passes...</p>
      </div>
    );
  }

  if (phase === "debrief") {
    return (
      <div className="app">
        <div className="debrief">
          <p className="dim">debrief — in the solo prototype, just continue</p>
          <button onClick={endDebrief} className="btn">
            next event
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <p>{phase}</p>
    </div>
  );
}
```

- [ ] **Step 4: Add component styles to global.css**

Append to `client/src/global.css`:

```css
.start-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 80dvh;
  gap: 16px;
}

.start-screen h1 {
  font-weight: 300;
  font-size: 24px;
  letter-spacing: 2px;
}

.dim { color: var(--fg-dim); }

.name-input {
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--fg-dim);
  color: var(--fg);
  font-family: var(--font);
  font-size: 18px;
  padding: 8px 0;
  text-align: center;
  outline: none;
  width: 200px;
}

.relationship-select {
  background: transparent;
  border: 1px solid var(--fg-dim);
  color: var(--fg);
  font-family: var(--font);
  font-size: 13px;
  padding: 8px 12px;
  text-align: center;
  outline: none;
  width: 260px;
  appearance: none;
  cursor: pointer;
}

.relationship-select option {
  background: var(--bg);
  color: var(--fg);
}

.btn {
  background: transparent;
  border: 1px solid var(--fg-dim);
  color: var(--fg);
  font-family: var(--font);
  font-size: 13px;
  padding: 8px 24px;
  cursor: pointer;
  letter-spacing: 1px;
  margin-top: 16px;
}

.btn:hover { border-color: var(--fg); }
.btn:disabled { opacity: 0.3; cursor: default; }
.btn-secondary { border-color: var(--fg-dim); color: var(--fg-dim); font-size: 11px; margin-top: 24px; }

.age-marker {
  text-align: center;
  color: var(--fg-dim);
  font-size: 13px;
  letter-spacing: 3px;
  padding: 24px 0 16px;
}

.event-intro {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 80dvh;
  gap: 24px;
  text-align: center;
  padding: 0 24px;
}

.event-description {
  font-size: 16px;
  line-height: 1.8;
  max-width: 400px;
  font-style: italic;
}

.chat {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 8px;
}

.message-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 0;
}

.message {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.message-sender {
  font-size: 11px;
  color: var(--fg-dim);
  letter-spacing: 1px;
}

.message-kid .message-sender { color: var(--kid); }
.message-kid .message-content { color: var(--kid); font-style: italic; }

.message-content {
  font-size: 15px;
  line-height: 1.6;
}

.message-input {
  display: flex;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid #222;
}

.message-input input {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--fg);
  font-family: var(--font);
  font-size: 15px;
  outline: none;
}

.message-input input::placeholder { color: #444; }

.message-input button {
  background: transparent;
  border: 1px solid #333;
  color: var(--fg-dim);
  font-family: var(--font);
  font-size: 12px;
  padding: 6px 16px;
  cursor: pointer;
}

.message-input button:hover { border-color: var(--fg); color: var(--fg); }
.message-input button:disabled { opacity: 0.2; cursor: default; }

.debrief {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 80dvh;
  gap: 16px;
}
```

- [ ] **Step 5: Verify the full app runs**

Run: `ANTHROPIC_API_KEY=<your-key> npm run dev`
Expected: browser opens, you can name a child, generate an event, chat with the kid, see streaming responses, end the chat, and proceed to the next event. The kid responds differently in event 2 based on what happened in event 1.

- [ ] **Step 6: Commit**

```bash
git add client/src/
git commit -m "feat: React chat UI with streaming responses for solo prototype"
```

---

## Milestone 2: Multiplayer (SKETCH)

Add the second player. Replace HTTP+SSE with Socket.io for real-time bidirectional communication.

### Task 8: Socket.io infrastructure
- Add `socket.io` to server, `socket.io-client` to client
- Create `server/src/socket/handlers.ts` — game rooms, join/leave, message relay
- Move game state management to socket event handlers
- Both players see the same game state, messages appear in real time

### Task 9: Lobby flow
- Player 1 creates game, gets shareable link with high-entropy token (e.g., `/game/a7f3k9m2x`)
- Player 2 opens link, joins lobby
- Both see the child-naming and relationship-selection screen together (relationship UI from M1, now collaborative)
- Both must ready up to start
- Knowing the link = being a player — no separate auth, but only two players per game (enforced server-side)

### Task 10: Two-player chat
- Both parents can send messages during family chat
- Messages labeled "Parent 1" / "Parent 2" (or display names)
- Kid responds to either parent's message
- Both see streaming responses simultaneously

### Task 11: Parent debrief
- After psychologist processes, open a parent-only chat room
- Time-boxed (configurable, default 4 minutes)
- Visible countdown timer (subtle)
- Both must ready up to proceed (or timer expires)

---

## Milestone 3: Sidebars (SKETCH)

### Task 12: Sidebar mechanic
- "Talk privately" button during family chat
- Initiating parent enters a private 1-on-1 with the kid
- Other parent sees "Parent 1 is talking privately..." indicator
- Shared chat pauses — no new shared messages while sidebar is active
- Up to 12 messages in sidebar
- Either parent can initiate one sidebar per event
- On sidebar end, return to shared family chat

### Task 13: Sidebar visibility rules
- Sidebar messages stored with `chatType: "private"` and `visibleTo` array
- Psychologist sees all messages (shared + private) for identity doc updates
- Other parent never sees sidebar content (even in endgame)

---

## Milestone 4: Full Game Loop (SKETCH)

### Task 14: World Manager integration
- Replace hardcoded events with World Manager LLM calls
- Generate events reactively based on identity document + parenting dynamics
- 10-12 events total, ages ~3-18
- Pacing guidance in prompt: mix of mundane and dramatic, appropriate age progression

### Task 15: Event counter and game progression
- Track event count toward 10-12 total
- After final childhood event, transition to endgame
- Show event count subtly in UI (e.g., "3 of 12")

---

## Milestone 5: Endgame (SKETCH)

### Task 16: Epilogue generation
- World Manager generates 3-4 paragraph narrative of adult life
- Both players read simultaneously
- Typographic presentation — no rush, let it breathe

### Task 17: Adult conversations
- 2-3 conversations with the adult child
- World Manager generates scenario prompts based on epilogue
- Same chat UI, full identity document drives kid personality
- 12 messages per conversation

### Task 18: Report card
- Generated from final identity doc, all snapshots, epilogue, and conversation logs
- Structured format: traits, strengths, struggles, pivotal moments, quotes, voices
- Clean typographic layout — the most designed screen
- Identity doc timeline: who they were at each age

---

## Milestone 6: Persistence & Observability (SKETCH)

### Task 19: Postgres setup & session reconnect
- Docker Compose for local Postgres
- Migration script: `001-initial.sql` with games (including `relationship_type`), players, events, messages, identity_snapshots, endgames tables
- `GameRepository` class with write-through methods
- Wire into game flow — persist messages, snapshots, and endgame artifacts as they happen
- On reconnect via session link, reconstruct in-memory state from latest Postgres checkpoint
- Games can be resumed across sessions — open the link later, pick up where you left off

### Task 20: Langfuse integration
- Add `langfuse` SDK
- Wrap all LLM calls in Langfuse traces
- Tag each trace with game_id, event_number, llm_role (kid/world_manager/psychologist)
- Include identity document state in trace metadata

---

## Milestone 7: Polish (SKETCH)

### Task 21: UI aesthetic
- Refine typography, spacing, transitions
- Scene transitions: fades between phases
- "Time passes..." loading screen with appropriate pacing
- Mobile optimization: bottom-anchored input, safe area handling

### Task 22: Edge cases and resilience
- Handle player disconnects (reconnect to game via link)
- Handle LLM API errors gracefully (retry with backoff)
- Handle browser refresh (restore game state from server)
