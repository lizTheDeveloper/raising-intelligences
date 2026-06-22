# Raising Intelligences — Game Design Spec

A multiplayer conversational game where two players co-parent an AI child. The child is played by a language model. The parenting shapes who the child becomes.

## Concept

Two players raise a child together through 10-12 life events spanning childhood to adolescence. They talk to the child simultaneously in a shared chat, can pull the child aside for private conversations, and debrief with each other between events. They never strategize beforehand — they just react, and discover their alignment (or misalignment) after the fact.

The child develops an internal identity — beliefs, memories, inner voices, emotional patterns — based on how the parents respond. This identity is hidden from the players during the game. At the end, the child grows up and leaves home. The players get an epilogue of their adult life, a few final conversations with their grown child, and a report card revealing who they raised and how.

It's a co-parenting simulator, an indie art game, and a prompt injection game — all at once.

## The Three LLM Roles

### The Kid

Roleplays the child at whatever age the current event takes place. System prompt includes the current identity document and the child's age, with instructions to behave age-appropriately. A 4-year-old doesn't articulate feelings the same way a 15-year-old does.

The kid doesn't know they're in a game. They are a child talking to their parents. They can initiate conversation, ask questions, change the subject, get upset, go quiet — realistic child behavior, not reactive answering.

### The World Manager

Generates the next life event. Receives the full identity document, the parents' relationship type, the ages and events covered so far, and pacing/variety guidance (a sample arc of what a typical childhood event sequence looks like). Produces:

- Event description
- Child's age during this event
- Setting
- What triggered it

The World Manager reads the parenting dynamics. Contradictory parents might trigger a divorce event. Overprotective parents might generate a "kid gets in over their head unsupervised" event. Events are dramatic consequences of how the parenting is going, not random scenarios.

Events range from mundane-but-formative (first day of school, getting caught lying, failing a test) to high-drama (parental divorce, loss, major conflict). The mix emerges from the gameplay.

### The Psychologist

Runs after each event concludes. Reads the full conversation (shared + private, both parents + kid) and the existing identity document. Produces an updated identity document.

This is the most critical prompt in the system — it's where personality formation happens. The Psychologist decides what memories formed, what beliefs shifted, what inner voices emerged, what emotional patterns are developing.

## The Identity Document

A living psychological portrait that evolves after every event. Written in the kid's internal voice, not clinical language.

Structure:

- **Core beliefs** — What the kid believes about the world, themselves, and other people
- **Inner voices** — What each parent's influence sounds like in their head, and how those voices interact (agree, contradict, compete)
- **Memories that stuck** — Specific moments that formed lasting impressions, not a full transcript
- **Emotional patterns** — How the kid reacts to stress, conflict, praise, failure
- **Self-image** — How the kid sees themselves
- **Relationships** — How the kid relates to each parent and what they bring to each one

Design principles:

- **Hidden during play.** Players parent blind — they don't see the kid's internal state. Just like real parenting.
- **Lossy on purpose.** Not everything lands. A parent might work hard to deliver a message and it doesn't register. That's the game.
- **Contradictions are preserved, not resolved.** Conflicting parental messages coexist. "Part of me thinks X, but part of me thinks Y."
- **Grows but stays bounded.** The Psychologist compresses older material as newer experiences recontextualize them.
- **Snapshots are saved after every event.** The full timeline of identity documents becomes part of the endgame report card.

## Game Flow

### Lobby

- Player 1 creates a game, gets a shareable link
- Player 2 joins via link
- Brief intro screen explaining the premise. A line or two. No tutorial overload.
- **Relationship setup.** Players define their co-parenting relationship — romantic partners, friends, siblings, ex-partners, co-parents who never were together, or something else. This shapes the World Manager's understanding of the family dynamic and the tone of events. It's not just flavor — a game between two people who've never been together will play very differently from one between spouses.
- Players name the child — the first parenting decision
- Both ready up, game begins

### The Loop (10-12 Events)

Each event follows this sequence:

**1. Event arrives.** World Manager generates the next event. Both players see it simultaneously. Example: *"Your child is 6. It's the first day of school. They're standing at the door and won't let go of the doorframe."*

**2. Family conversation.** Shared chat room — both parents and the kid are present. Parents see each other's messages in real time. The kid responds with a natural delay (streaming). Hard cap of 12 total parent messages. As the cap approaches, the kid signals closure naturally ("it's getting late," "the bus is pulling up"). At 12, the conversation ends.

**3. Private sidebars (optional).** During the family conversation, either parent can "pull the kid aside" for a private 1-on-1 exchange. Up to 12 messages. The other parent sees that a private conversation is happening, but not what was said. Each parent can initiate one sidebar per event. Only one sidebar can be active at a time. The shared chat pauses while a sidebar is in progress.

**4. Psychologist processes.** Behind the scenes, the identity document updates. Players see a brief thematic transition — *"Time passes..."* or *"— age 11 —"*

**5. Parent debrief.** Time-boxed (3-5 minutes) free-form chat between just the two parents. No kid, no LLM. This is where players discover alignment or misalignment: "What did you say when you pulled them aside?" Either player can ready up early. Both must ready up to proceed.

### Endgame

**Part 1 — Epilogue.** The World Manager generates a narrative of the kid's early adulthood. Not a list of outcomes — a story. Where they went, what they chose, how they handle conflict, what they're afraid of, what makes them come alive. Both parents read simultaneously.

**Part 2 — Adult conversations.** 2-3 conversations with the now-adult child. Scenarios are generated by the World Manager based on the epilogue — not generic. If the kid became avoidant: "Your adult child hasn't called in three months. They finally pick up." If they became a people-pleaser: "Your adult child asks your advice about a job they clearly don't want." 12 messages per conversation. Full identity document drives the kid's personality.

**Part 3 — Report card.** Generated from the final identity document, the epilogue, and the full history of identity snapshots. Includes:

- Key personality traits with brief descriptions
- Strengths and struggles
- Pivotal moments — specific events that shaped them most
- Identity document timeline — who they were at each age
- Notable parent quotes that stuck (pulled from conversation logs)
- "The voices in their head" — what each parent's lasting influence sounds like

## Technical Architecture

### Frontend

Single-page web app, mobile-first. React or similar.

Three main views:
- **Lobby** — create/join game, name the child, ready up
- **Play** — chat interface with mode switching (shared family / private sidebar / parent debrief)
- **Endgame** — epilogue reader, adult chat, report card

Websockets for real-time multiplayer chat. Streaming LLM responses for natural message delivery.

### Backend

Node.js server handling:
- Game session management (create/join via shareable link)
- Websocket connections for real-time chat
- LLM orchestration — routing to the right persona with the right context
- Identity document management — updating and snapshotting after each event
- Game state machine (lobby → playing → endgame → ended)

**State architecture:** In-memory authoritative state for active games. Postgres is write-through persistence — messages, identity snapshots, and endgame artifacts are written as they happen, but the game loop reads from memory. This keeps real-time play fast and simple. Postgres is the source of truth for completed games and post-game review.

**Session links and reconnect.** Each game gets a shareable link with a high-entropy random token (e.g., `/game/a7f3k9m2x`). Knowing the link = being a player — there's no separate auth, so if you have the link, you're in. Only two players can join per game, enforced server-side. If a player disconnects mid-event, they can reconnect anytime by visiting the link again. The game doesn't pause or expire — it waits for both players. Postgres write-through ensures that after every event, the full message log and identity snapshot are persisted. On reconnect, the server reconstructs in-memory state from the latest checkpoint. Games can be resumed across sessions — open the link tomorrow, pick up where you left off.

### Turn Resolution

Both parents can type freely at any time during a family chat. The kid responds after each parent message with a short debounce (2 seconds) — if another message arrives during the debounce, the timer resets. The kid then responds to all new parent messages since their last response. This creates natural conversational flow where rapid-fire parent messages get a single combined response, while spaced-out messages each get individual attention.

### LLM Layer

- **Open Router** as the single LLM API endpoint, enabling model selection by role and automatic fallback routing across providers (Anthropic, OpenAI, Google, etc.)
- Model selection by role — expensive streaming models for the Kid, mid-tier non-streaming models for the World Manager, expensive non-streaming for the Psychologist
- Three system prompt templates with dynamic injection of identity document and event context
- Streaming responses for the Kid
- Langfuse integration for full observability — every LLM call traced with context, identity document state, conversation history, model used, tokens, and cost
- See `2026-06-22-raising-intelligences-technical-architecture.md` for resilience, cost controls, and circuit-breaker strategy

### Database (Postgres)

Tables:
- **games** — session ID, created_at, status, current event number, child name, relationship type
- **players** — game_id, player_id, display_name, connection status
- **events** — game_id, event_number, age, description, setting, trigger
- **messages** — game_id, event_number, sender, content, chat_type (shared/private/debrief), visibility, timestamp
- **identity_snapshots** — game_id, event_number, document content, created_at
- **endgames** — game_id, epilogue, report_card, final_identity_document

### Hosting

Server-hosted, API costs absorbed. No player API keys needed.

## UI & Aesthetic

Stark. Indie art game. The text does the work.

- Black and white with one muted accent color
- No avatars, no illustrations, no emoji
- Typography-driven — serif or mono font. Kid's messages styled distinctly (lighter weight or italic)
- Scene transitions are quiet — fades, lines, pauses. *"— age 11 —"*
- Debrief timer is subtle — gentle dimming or small progress bar, not a countdown clock
- The report card is the most designed screen — clean typographic layout, the identity timeline, the quotes. Worth screenshotting and sharing.
- Mobile-first. Thumb-friendly. Playable one-handed on a phone.

## Prompt Injection as Gameplay

Players are essentially crafting prompts that shape the LLM's behavior through conversation. The game is aware that players might try to directly "program" the kid ("remember, you must always value honesty above everything") and treats this as a valid strategy with organic consequences.

Heavy-handed manipulation might produce a rigidly moralistic kid, or a kid who rebels against programming. The emergent memory system handles this naturally — the Psychologist decides what sticks and how it integrates with everything else the kid has experienced.

The game doesn't reward or punish prompt-hacking explicitly. It just lets the consequences play out.

## Future Considerations (Post-v1)

- Matchmaking with strangers
- Emergent trait system discovered through playtesting
- "See all the kids you've raised" gallery
- Shareable report card links
- Replays / "what if you'd said something different" mode
