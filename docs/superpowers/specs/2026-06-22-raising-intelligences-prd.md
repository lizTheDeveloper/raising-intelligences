# Raising Intelligences — Product Requirements Document

## 1. Introduction

### 1.1 Purpose

This document defines the product requirements for **Raising Intelligences**, a multiplayer browser-based conversational game. It serves as the authoritative specification for development, testing, and release decisions. For game mechanics, narrative design, and aesthetic direction, see the companion [Game Design Spec](2026-06-22-raising-intelligences-design.md).

### 1.2 Scope

**In scope for v1:**
- Two-player real-time multiplayer via shareable link
- 10-12 dynamically generated life events per game session
- Shared family chat, private sidebars, and parent debrief phases
- LLM-driven child, world manager, and psychologist roles
- Hidden identity document with per-event snapshots
- Three-part endgame: epilogue narration, adult conversations, report card
- Relationship setup between co-parents
- Session persistence and reconnection
- LLM observability via Langfuse
- Postgres persistence for game data

**Explicitly out of scope for v1:**
- Matchmaking with strangers (link-sharing only)
- Formalized trait/stat system (emergent memory only)
- User accounts or authentication beyond link-based access
- Game gallery ("see all the kids you've raised")
- Shareable report card links (public URLs)
- Replay or "what if" mode
- Monetization or payment processing
- Native mobile apps (browser only)
- Multiplayer beyond two players
- Content moderation / automated safety filtering
- Localization / multi-language support

### 1.3 Target Audience

This document is intended for:
- **Developers** implementing the application
- **Designers** building the UI/UX
- **The product owner** making scope and priority decisions
- **QA/playtesters** validating the experience
- **AI/LLM engineers** tuning prompts and observing behavior via Langfuse

### 1.4 Definitions and Acronyms

| Term | Definition |
|------|-----------|
| **Identity Document** | A living narrative text representing the child's psychological state — beliefs, memories, inner voices, emotional patterns. Updated by the Psychologist after each event. Hidden from players during gameplay. |
| **The Kid** | The LLM role that roleplays the child at their current age during conversations with the parents. |
| **World Manager** | The LLM role that generates life events based on the child's identity and parenting dynamics. |
| **Psychologist** | The LLM role that reads each event's conversation and updates the identity document. |
| **Event** | A single life scenario presented to both parents. Each game has 10-12 events spanning ages ~3-18. |
| **Family Chat** | The shared conversation phase where both parents and the kid are present. |
| **Sidebar** | A private 1-on-1 conversation between one parent and the kid, invisible to the other parent. |
| **Debrief** | A time-boxed chat between the two parents only, occurring after each event. |
| **Epilogue** | A generated narrative of the child's adult life (ages 18-25), produced at endgame. |
| **Report Card** | The structured endgame artifact summarizing the child's personality, pivotal moments, and parental influence. |
| **Debounce** | The 2-second delay before the kid responds, which resets when additional parent messages arrive. |
| **LLM** | Large Language Model — the AI system (Claude) that powers the Kid, World Manager, and Psychologist roles. |
| **SSE** | Server-Sent Events — a protocol for streaming server-to-client data over HTTP. |
| **Langfuse** | An open-source LLM observability platform used to trace and monitor all LLM calls. |

### 1.5 References

| Document | Location |
|----------|----------|
| Game Design Spec | `docs/superpowers/specs/2026-06-22-raising-intelligences-design.md` |
| Implementation Plan | `docs/superpowers/plans/2026-06-22-raising-intelligences.md` |
| Claude API Documentation | https://docs.anthropic.com |
| Langfuse Documentation | https://langfuse.com/docs |

---

## 2. Goals and Objectives

### 2.1 Business Goals

- **BG-1:** Launch a playable v1 as an indie art game / interactive experience that demonstrates a novel use of conversational AI
- **BG-2:** Generate a corpus of playthroughs (via Langfuse + Postgres) to discover emergent personality traits and inform future game design iterations
- **BG-3:** Create a shareable artifact (the report card) that drives organic word-of-mouth and social sharing

### 2.2 User Goals

- **UG-1:** Experience what it feels like to shape an intelligence through conversation, with another person
- **UG-2:** Discover how alignment (or misalignment) with a co-parent affects a child's development
- **UG-3:** Receive a meaningful, personalized artifact (the report card) that reflects their specific parenting choices
- **UG-4:** Complete a full game in a single session (target: 60-90 minutes)

### 2.3 Success Metrics

| Metric | Target | How Measured |
|--------|--------|-------------|
| Session completion rate | >60% of started games reach the report card | Postgres game status |
| Session duration | 45-90 minutes median | Postgres timestamps (game created_at to endgame created_at) |
| Endgame engagement | >80% of players who reach epilogue also complete adult conversations | Postgres event/message data |
| LLM coherence | <5% of kid responses flagged as "out of character" in playtest feedback | Manual playtest review + Langfuse trace analysis |
| Report card resonance | >70% of playtesters rate report card as "felt true to the game we played" | Post-game survey |
| Reconnection success | >90% of disconnected players successfully resume | Postgres + server logs |

---

## 3. User Stories

### 3.1 Core Gameplay

**US-1: Create a game**
As a player, I want to create a new game and get a shareable link so that I can invite someone to co-parent with me.
*Acceptance criteria:* Player receives a URL. Opening the URL in another browser joins the same game. No login required.

**US-2: Join a game**
As a player, I want to open a link and immediately join a game so that I can start playing without account creation.
*Acceptance criteria:* Opening the link places the player in the lobby. If two players are already connected, additional visitors are rejected with a message.

**US-3: Define relationship**
As a co-parent, I want to define my relationship with the other player (romantic partners, friends, exes, etc.) so that the game generates events appropriate to our family dynamic.
*Acceptance criteria:* Both players see the relationship options. The chosen relationship is passed to the World Manager and influences event generation.

**US-4: Name the child**
As a co-parent, I want to name our child together so that the first parenting decision feels collaborative.
*Acceptance criteria:* Both players can propose a name. The game begins when both agree on one and ready up.

**US-5: Talk to the kid in a shared conversation**
As a parent, I want to talk to my child alongside the other parent so that I can respond to events together in real time.
*Acceptance criteria:* Both parents see each other's messages. The kid responds to messages with a natural streaming delay. Messages are labeled by sender.

**US-6: Pull the kid aside**
As a parent, I want to have a private conversation with the kid that the other parent can't see so that I can say things I wouldn't say in front of them.
*Acceptance criteria:* Initiating parent enters a private chat. Other parent sees an indicator that a private conversation is happening but not the content. Up to 12 messages. One sidebar per parent per event.

**US-7: Debrief with my co-parent**
As a parent, I want to talk to the other parent after each event so that we can process what just happened and decide how to approach the next one.
*Acceptance criteria:* Free-form text chat, no LLM. Timer visible. Both must ready up (or timer expires) to proceed.

**US-8: See the epilogue**
As a parent, I want to read a narrative of my child's adult life so that I can see the long-term consequences of my parenting.
*Acceptance criteria:* Both parents see the same narrative simultaneously. The narrative references specific events and parenting patterns from gameplay.

**US-9: Talk to my adult child**
As a parent, I want to have a conversation with my grown child so that I can experience who they became through direct interaction.
*Acceptance criteria:* 2-3 conversations with scenarios generated from the epilogue. The adult child's personality reflects the full identity document.

**US-10: See the report card**
As a parent, I want to see a structured summary of who my child became so that I have a tangible artifact from the experience.
*Acceptance criteria:* Report card includes personality traits, strengths, struggles, pivotal moments, identity timeline across ages, parent quotes that stuck, and "the voices in their head."

**US-11: Reconnect to a game**
As a player, I want to rejoin a game I disconnected from by visiting the same link so that I don't lose progress.
*Acceptance criteria:* Visiting the link restores the player's view to the current game state. All prior messages and events are visible. Game resumes from wherever it was.

### 3.2 Edge Cases

**US-12: Only one player connected**
As a player waiting for my co-parent to join, I want to see that the game is waiting so that I know nothing is broken.
*Acceptance criteria:* Lobby shows waiting state. Game does not start until both players are connected and ready.

**US-13: Message cap reached**
As a parent, I want the conversation to end naturally when we've sent enough messages so that the game maintains pacing.
*Acceptance criteria:* As messages approach the cap, the kid's dialogue signals scene closure. At the cap, no more parent messages can be sent. An "end conversation" action becomes available.

---

## 4. Functional Requirements

### 4.1 Game Session Management

| ID | Requirement | Priority | Traces to |
|----|------------|----------|-----------|
| FR-001 | The system MUST generate a unique, high-entropy URL token (minimum 64 bits of entropy) for each game session. | High | US-1 |
| FR-002 | The system MUST allow exactly two players to join a game session via the shareable link. | High | US-2 |
| FR-003 | The system MUST reject additional connection attempts to a full game with a clear message. | High | US-2 |
| FR-004 | The system MUST allow a disconnected player to reconnect by visiting the same link. | High | US-11 |
| FR-005 | The system MUST reconstruct the player's view from persisted state on reconnection. | High | US-11 |
| FR-006 | The system SHOULD NOT expire game sessions — a game in progress MUST remain joinable indefinitely. | Medium | US-11 |

### 4.2 Lobby

| ID | Requirement | Priority | Traces to |
|----|------------|----------|-----------|
| FR-010 | The system MUST display a brief introduction explaining the game premise. | Medium | US-1 |
| FR-011 | The system MUST allow players to select a co-parenting relationship type from a predefined list (romantic partners, friends, siblings, ex-partners, co-parents who never were together, other). | High | US-3 |
| FR-012 | The system MUST allow both players to propose and agree on the child's name. | High | US-4 |
| FR-013 | The system MUST require both players to "ready up" before the game begins. | High | US-4 |
| FR-014 | The system MUST pass the selected relationship type to the World Manager for event generation context. | High | US-3 |

### 4.3 Family Chat

| ID | Requirement | Priority | Traces to |
|----|------------|----------|-----------|
| FR-020 | The system MUST display both parents' messages and the kid's messages in a shared, real-time chat interface. | High | US-5 |
| FR-021 | The system MUST label each message with its sender (Parent 1 display name, Parent 2 display name, or child's name). | High | US-5 |
| FR-022 | The system MUST stream the kid's responses character-by-character with a natural delay. | High | US-5 |
| FR-023 | The system MUST debounce kid responses by 2 seconds — if a new parent message arrives within 2 seconds of the previous one, the timer resets and the kid responds to all accumulated messages. | High | US-5 |
| FR-024 | The system MUST enforce a hard cap of 12 parent messages per event across both parents. | High | US-13 |
| FR-025 | The system SHOULD instruct the kid to signal natural scene closure as the message cap approaches (within 2-3 messages of the cap). | Medium | US-13 |
| FR-026 | The system MUST prevent parent messages after the cap is reached. | High | US-13 |
| FR-027 | The system MUST provide an "end conversation" action available at any time during family chat. | Medium | US-5 |

### 4.4 Private Sidebars

| ID | Requirement | Priority | Traces to |
|----|------------|----------|-----------|
| FR-030 | The system MUST allow either parent to initiate a private sidebar with the kid during family chat. | High | US-6 |
| FR-031 | The system MUST limit each parent to one sidebar per event. | High | US-6 |
| FR-032 | The system MUST allow only one active sidebar at a time. | High | US-6 |
| FR-033 | The system MUST pause the shared family chat while a sidebar is active. | High | US-6 |
| FR-034 | The system MUST show the non-participating parent an indicator that a private conversation is in progress, without revealing its content. | High | US-6 |
| FR-035 | The system MUST limit sidebars to 12 messages. | High | US-6 |
| FR-036 | The system MUST include sidebar messages in the Psychologist's input for identity document updates. | High | US-6 |
| FR-037 | The system MUST NOT reveal sidebar content to the other parent at any point, including the endgame report card. | High | US-6 |

### 4.5 Psychologist & Identity Document

| ID | Requirement | Priority | Traces to |
|----|------------|----------|-----------|
| FR-040 | The system MUST invoke the Psychologist LLM after every event's family chat (including sidebars) concludes. | High | Design Spec §Psychologist |
| FR-041 | The system MUST pass the full conversation transcript (shared + all private sidebars) and the current identity document to the Psychologist. | High | Design Spec §Psychologist |
| FR-042 | The system MUST store a snapshot of the identity document after every event. | High | Design Spec §Identity Document |
| FR-043 | The system MUST NOT display the identity document to players during gameplay. | High | Design Spec §Identity Document |
| FR-044 | The system MUST display the identity document timeline as part of the endgame report card. | High | US-10 |

### 4.6 Parent Debrief

| ID | Requirement | Priority | Traces to |
|----|------------|----------|-----------|
| FR-050 | The system MUST provide a free-form text chat between both parents after each event's psychologist processing completes. | High | US-7 |
| FR-051 | The system MUST NOT include any LLM participation in the debrief. | High | US-7 |
| FR-052 | The system MUST time-box the debrief to a configurable duration (default: 4 minutes). | High | US-7 |
| FR-053 | The system MUST display a subtle timer indicator during the debrief. | Medium | US-7 |
| FR-054 | The system MUST allow either player to "ready up" to end the debrief early. | High | US-7 |
| FR-055 | The system MUST require both players to ready up (or timer expiry) before proceeding to the next event. | High | US-7 |

### 4.7 World Manager & Event Generation

| ID | Requirement | Priority | Traces to |
|----|------------|----------|-----------|
| FR-060 | The system MUST generate each event dynamically using the World Manager LLM, informed by the current identity document, prior events, and parenting relationship type. | High | Design Spec §World Manager |
| FR-061 | Each generated event MUST include: event description, child's age, setting, and trigger. | High | Design Spec §World Manager |
| FR-062 | The system MUST generate 10-12 events per game, spanning ages approximately 3-18. | High | Design Spec §Game Flow |
| FR-063 | The system MUST present each event to both players simultaneously before the family chat begins. | High | US-5 |

### 4.8 Endgame

| ID | Requirement | Priority | Traces to |
|----|------------|----------|-----------|
| FR-070 | The system MUST generate an epilogue narrative (3-4 paragraphs) of the child's adult life after the final childhood event. | High | US-8 |
| FR-071 | The epilogue MUST reference specific events, memories, and parenting patterns from gameplay. | High | US-8 |
| FR-072 | The system MUST present 2-3 adult conversation scenarios generated from the epilogue. | High | US-9 |
| FR-073 | Adult conversations MUST use the full, final identity document to drive the child's personality. | High | US-9 |
| FR-074 | Adult conversations MUST be limited to 12 messages each. | High | US-9 |
| FR-075 | The system MUST generate a report card including: personality traits, strengths, struggles, pivotal moments, identity timeline, parent quotes that stuck, and "the voices in their head." | High | US-10 |
| FR-076 | The report card MUST be generated from the final identity document, all identity snapshots, the epilogue, and the full conversation history. | High | US-10 |

### 4.9 Observability

| ID | Requirement | Priority | Traces to |
|----|------------|----------|-----------|
| FR-080 | The system MUST trace every LLM call through Langfuse with: game ID, event number, LLM role (kid/world_manager/psychologist), and the full prompt context. | High | BG-2 |
| FR-081 | The system MUST include the identity document state in Langfuse trace metadata for Psychologist and Kid calls. | Medium | BG-2 |

### 4.10 Data Persistence

| ID | Requirement | Priority | Traces to |
|----|------------|----------|-----------|
| FR-090 | The system MUST persist all messages (shared, private, debrief) to Postgres as they occur. | High | US-11 |
| FR-091 | The system MUST persist identity document snapshots to Postgres after each event. | High | FR-042 |
| FR-092 | The system MUST persist endgame artifacts (epilogue, report card, final identity document) to Postgres. | High | US-10 |
| FR-093 | The system MUST be able to reconstruct full in-memory game state from Postgres on server restart or player reconnect. | High | US-11 |

---

## 5. Non-Functional Requirements

### 5.1 Performance

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-001 | The system MUST begin streaming the kid's response within 3 seconds of the debounce timer expiring. | High |
| NFR-002 | Websocket message delivery between players MUST have <200ms latency under normal conditions. | High |
| NFR-003 | The Psychologist identity update MUST complete within 15 seconds. | Medium |
| NFR-004 | The World Manager event generation MUST complete within 10 seconds. | Medium |
| NFR-005 | The epilogue generation MUST complete within 30 seconds. | Medium |
| NFR-006 | The report card generation MUST complete within 30 seconds. | Medium |
| NFR-007 | The system SHOULD support at least 20 concurrent active games on a single server instance. | Low |
| NFR-008 | Page initial load MUST complete within 3 seconds on a 4G mobile connection. | Medium |

### 5.2 Security

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-010 | Game session tokens MUST contain at least 64 bits of entropy (e.g., 11+ alphanumeric characters) to prevent guessing. | High |
| NFR-011 | The system MUST NOT expose the ANTHROPIC_API_KEY to the client. | High |
| NFR-012 | The system MUST rate-limit game creation to prevent abuse (SHOULD allow no more than 10 games per IP per hour). | Medium |
| NFR-013 | The system MUST rate-limit messages to prevent flooding (SHOULD allow no more than 5 messages per player per 10 seconds). | Medium |
| NFR-014 | The system MUST NOT log or expose API keys in Langfuse traces, server logs, or client-visible responses. | High |
| NFR-015 | Websocket connections MUST be scoped to the player's game session — a player MUST NOT be able to read or write to another game's websocket channel. | High |

### 5.3 Usability

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-020 | A new player MUST be able to start their first game within 60 seconds of opening the link, with no prior instructions beyond the in-game intro. | High |
| NFR-021 | All interactive elements MUST have touch targets of at least 44x44px for mobile usability. | High |
| NFR-022 | The chat input MUST remain visible and accessible when the mobile keyboard is open. | High |
| NFR-023 | The system SHOULD provide clear visual feedback for all state transitions (loading, waiting for other player, processing). | Medium |
| NFR-024 | The system MUST clearly indicate whose turn it is and what actions are available at all times. | High |

### 5.4 Accessibility

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-030 | The application MUST meet WCAG 2.1 Level AA compliance. | Medium |
| NFR-031 | All text MUST have a contrast ratio of at least 4.5:1 against its background. | High |
| NFR-032 | The application MUST be fully navigable via keyboard. | Medium |
| NFR-033 | All interactive elements MUST have accessible labels (aria-label or visible text). | Medium |
| NFR-034 | Streaming messages MUST be announced to screen readers via an aria-live region. | Low |
| NFR-035 | The timer in the debrief phase MUST be accessible to screen readers (aria-timer or equivalent). | Low |

### 5.5 Reliability

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-040 | The system MUST handle LLM API failures gracefully — retry with exponential backoff (up to 3 retries) before showing an error to the player. | High |
| NFR-041 | The system MUST handle websocket disconnects gracefully — attempt automatic reconnection with exponential backoff. | High |
| NFR-042 | The system MUST NOT lose game state on server restart — Postgres write-through ensures recovery. | High |
| NFR-043 | If the LLM returns an unparseable response for the World Manager (event generation), the system MUST retry up to 3 times before falling back to a generic age-appropriate event. | Medium |
| NFR-044 | The system SHOULD handle browser tab backgrounding/foregrounding without losing websocket connection where possible. | Medium |

### 5.6 Maintainability

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-050 | System prompt templates MUST be stored as separate, editable text files or constants — not inlined in business logic. | High |
| NFR-051 | The LLM client MUST be behind an interface so the implementation can be swapped (e.g., Claude to another provider) without changing game logic. | High |
| NFR-052 | All game state transitions MUST be handled by a pure state machine with no side effects, testable without I/O. | High |
| NFR-053 | The codebase MUST use TypeScript strict mode throughout. | High |

### 5.7 Portability

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-060 | The application MUST function correctly in the latest two major versions of Chrome, Safari, Firefox, and Edge. | High |
| NFR-061 | The application MUST function correctly on iOS Safari and Android Chrome. | High |
| NFR-062 | The application MUST be responsive from 320px viewport width (iPhone SE) to 1440px (desktop). | High |

### 5.8 Data Requirements

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-070 | All conversation data MUST be stored in Postgres with the schema defined in the Design Spec §Database. | High |
| NFR-071 | Message content MUST be stored as UTF-8 text with no maximum length enforcement (LLM responses vary). | Medium |
| NFR-072 | Identity document content MUST be stored as text, not structured/parsed — it is free-form narrative. | High |
| NFR-073 | Game data MAY be retained indefinitely for analysis purposes. There is no automatic deletion policy in v1. | Low |
| NFR-074 | The system MUST NOT collect or store any personally identifiable information beyond player display names and conversation content entered voluntarily during gameplay. | High |

### 5.9 Error Handling and Logging

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-080 | The system MUST log all server errors with sufficient context for debugging (game ID, event number, error stack). | High |
| NFR-081 | All LLM calls MUST be logged via Langfuse including: latency, token usage, model version, and success/failure status. | High |
| NFR-082 | Client-side errors that prevent gameplay MUST be reported to the server for logging. | Low |
| NFR-083 | User-facing error messages MUST be non-technical and maintain the game's aesthetic tone (e.g., "Something went wrong. Trying again..." not "500 Internal Server Error"). | Medium |

### 5.10 Internationalization

Not in scope for v1. The game will be English-only. Internationalization MAY be considered in future versions.

### 5.11 Legal and Compliance

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-090 | The application SHOULD display a brief notice that conversations are processed by AI and stored for the game experience. | Medium |
| NFR-091 | The application MUST NOT collect email addresses, real names, or other PII beyond self-chosen display names. | High |
| NFR-092 | GDPR and CCPA compliance MAY be addressed in a future version if the game collects PII or targets EU/CA users commercially. | Low |

---

## 6. Technical Requirements

### 6.1 Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend framework | React | 19.x |
| Frontend build tool | Vite | 6.x |
| Language | TypeScript (strict mode) | 5.7+ |
| Backend runtime | Node.js | 20+ |
| Backend framework | Express | 5.x |
| Real-time communication | Socket.io | 4.x |
| Database | PostgreSQL | 16+ |
| Database driver | pg (node-postgres) | 8.x |
| LLM API | Claude via @anthropic-ai/sdk | latest |
| LLM Observability | Langfuse via langfuse SDK | latest |
| Testing | Vitest | 3.x |

### 6.2 Platform and Browser Compatibility

- **Desktop:** Chrome 120+, Safari 17+, Firefox 120+, Edge 120+
- **Mobile:** iOS Safari 17+, Android Chrome 120+
- **Viewport range:** 320px - 1440px
- **Input methods:** Touch, keyboard, screen reader

### 6.3 API Integrations

| API | Purpose | Auth Method |
|-----|---------|-------------|
| Claude API (Anthropic) | All LLM roles (Kid, World Manager, Psychologist) | API key (server-side only) |
| Langfuse | LLM call tracing and observability | API key (server-side only) |

### 6.4 Data Storage

- **Active games:** In-memory on the server (authoritative during gameplay)
- **Persistence:** Postgres write-through — messages, identity snapshots, events, and endgame artifacts written as they occur
- **Completed games:** Postgres is the source of truth
- **Reconnection:** Server reconstructs in-memory state from the latest Postgres checkpoint

See Design Spec §Database for the full schema.

### 6.5 Deployment Environment

| Aspect | Specification |
|--------|--------------|
| Hosting | Cloud VM or container (specific provider TBD — Fly.io, Railway, or similar) |
| Containerization | Docker (single container for server; static hosting for client build) |
| Database hosting | Managed Postgres (e.g., Neon, Supabase, or provider-included) |
| Environment variables | `ANTHROPIC_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `DATABASE_URL`, `PORT` |
| TLS | MUST serve over HTTPS in production |

---

## 7. Design Considerations

### 7.1 UI Design

No wireframes or mockups exist yet. Key design constraints from the Design Spec:

- **Aesthetic:** Stark, black and white, one muted accent color. Typography-driven. No avatars, illustrations, or emoji.
- **Font:** Monospace (IBM Plex Mono or similar)
- **Kid's messages:** Visually distinct from parent messages (lighter weight, italic, accent color)
- **Transitions:** Quiet — fades, lines, pauses. Age markers: *"— age 11 —"*
- **Report card:** The most designed screen. Clean typographic layout worth screenshotting.

Wireframes and mockups SHOULD be created during implementation of the frontend milestone.

### 7.2 UX Design

The primary user flow is linear:

```
Open link → Lobby (name child, choose relationship, ready up)
→ [Event intro → Family chat (+ optional sidebars) → Processing → Debrief] × 10-12
→ Epilogue → Adult conversations × 2-3 → Report card
```

Key UX principles:
- The game MUST always make clear what the player can do right now
- Waiting states (for LLM, for other player) MUST have visual feedback
- The chat input MUST feel instant and responsive even when the LLM is processing
- Scene transitions SHOULD have breathing room — don't rush between phases

### 7.3 Branding and Style

See Design Spec §UI & Aesthetic. The visual identity is minimalist and literary — closer to interactive fiction than a mobile game. The tone is serious but not somber.

---

## 8. Testing and Quality Assurance

### 8.1 Testing Strategy

| Type | Scope | Tooling |
|------|-------|---------|
| **Unit tests** | Game state machine, context assembler, turn resolution rules, message cap logic | Vitest |
| **Integration tests** | Conversation engine with mocked LLM client, API routes with mocked game state | Vitest |
| **LLM behavior testing** | Prompt quality, identity document coherence, age-appropriate kid responses | Langfuse evaluation traces + manual playtest |
| **End-to-end tests** | Full game flow in browser (create game → report card) | Playwright |
| **Manual playtesting** | Two humans play through a full game, note where the experience breaks | Structured playtest protocol |

**LLM output quality is NOT unit tested.** Tests verify that the correct prompt is assembled and the correct LLM role is invoked. The quality of LLM responses is evaluated through Langfuse traces and manual playtesting.

### 8.2 Acceptance Criteria

Acceptance criteria are defined per user story in §3. Additionally:

| Criterion | Test |
|-----------|------|
| A full game can be completed without errors | E2E test: two browser tabs, create game, play through 10 events, reach report card |
| The kid responds differently in later events based on earlier conversations | Manual playtest: compare kid behavior in event 1 vs event 8 |
| Private sidebar content influences the identity doc but is not visible to the other parent | Automated test: verify sidebar messages appear in Psychologist input but not in other parent's message stream |
| Reconnection restores full game state | Automated test: disconnect one player mid-event, reconnect via link, verify all messages and state are restored |
| Report card references actual gameplay events | Manual playtest: verify pivotal moments and quotes match real conversations |

### 8.3 Performance Testing

| Scenario | Target | How Tested |
|----------|--------|-----------|
| Kid response latency (time-to-first-token) | <3 seconds | Langfuse trace p95 |
| Websocket message round-trip | <200ms | Automated timing test |
| Psychologist processing time | <15 seconds | Langfuse trace p95 |
| Full game session duration | 45-90 minutes | Playtest logs |
| Memory usage per active game | <50MB | Server monitoring |
| Concurrent games on single instance | 20+ without degradation | Load test with mock LLM |

### 8.4 Security Testing

| Scenario | Test |
|----------|------|
| Session token entropy | Verify tokens contain >=64 bits of entropy |
| API key exposure | Scan client bundle for API key strings; verify keys not in websocket messages |
| Cross-game isolation | Attempt to send messages to a game the player hasn't joined |
| Rate limiting | Verify game creation and message rate limits are enforced |
| Websocket authentication | Verify unauthenticated websocket connections are rejected |

---

## 9. Deployment and Release

### 9.1 Deployment Process

1. Run full test suite (`npm test`)
2. Build client (`npm run build -w client`)
3. Build Docker image (server + client static files)
4. Run database migrations against production Postgres
5. Deploy container to hosting provider
6. Verify health check endpoint responds
7. Smoke test: create a game, send a message, verify kid responds

### 9.2 Release Criteria

The following MUST be true before release:

- [ ] All unit and integration tests pass
- [ ] At least 3 full-game playthroughs completed without blocking errors
- [ ] Report card generation produces coherent, game-specific output in all playthroughs
- [ ] Reconnection flow works (disconnect and rejoin mid-game)
- [ ] Mobile Safari and Android Chrome tested for full game flow
- [ ] Langfuse traces are being recorded for all LLM calls
- [ ] No API keys exposed in client bundle or network traffic
- [ ] HTTPS enforced in production

### 9.3 Rollback Plan

- Container deployments are versioned — rollback by deploying the previous image
- Database migrations are forward-only but additive (no destructive changes in v1)
- Active games at rollback time may be lost if the schema changed — acceptable for v1 given low traffic expectations

---

## 10. Maintenance and Support

### 10.1 Support Procedures

v1 is an indie project with no formal support channel. Players who encounter issues can:
- Refresh the browser and reconnect via the game link
- Start a new game if the current one is unrecoverable

### 10.2 Maintenance

| Activity | Frequency |
|----------|-----------|
| Review Langfuse traces for LLM quality issues | Weekly during active playtesting |
| Review Postgres for completed games to discover emergent trait patterns | As needed |
| Update Claude model version when new versions are available | As needed, with playtest validation |
| Prune old game data if storage becomes a concern | Not expected in v1 |

### 10.3 SLAs

No formal SLAs for v1. The application is best-effort. Target availability: "generally up" — no pager, no on-call.

---

## 11. Future Considerations

See Design Spec §Future Considerations. All items below are explicitly **out of scope** for v1:

- **Matchmaking:** Pair strangers to co-parent together
- **Emergent trait system:** Formalize discovered personality traits from playtest data into game mechanics
- **Game gallery:** "See all the kids you've raised" view for returning players
- **Shareable report cards:** Public URLs for sharing report cards socially
- **Replay mode:** "What if you'd said something different" branching replay
- **Content moderation:** Automated filtering of player messages (v1 relies on the social contract of two players who chose to play together)
- **Monetization:** Payment processing, premium features, or API key management for players

---

## Appendix A: Game State Machine

```
lobby → event_intro → family_chat ⇄ sidebar → processing → debrief → event_intro (repeat)
                                                                    → epilogue → adult_chat → report_card → ended
```

## Appendix B: Identity Document Example

See Design Spec §The Identity Document for the full structure. Example after a single event:

> **Core beliefs:** My parents are big and they fix things. If something breaks, it's probably okay.
>
> **Inner voices:** Mom's voice laughs and says "it's just a vase." Dad's voice gets quiet in a way that means something but I don't know what.
>
> **Memories that stuck:** The sound of the vase breaking and then the silence before anyone spoke.
>
> **Emotional patterns:** When something goes wrong, I freeze and look at faces to figure out if I'm in trouble.
>
> **Self-image:** I'm little. I break things sometimes.
>
> **Relationships:** Mom makes scary things not scary. Dad is harder to read.
