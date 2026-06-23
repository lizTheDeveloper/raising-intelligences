---
name: streaming-non-streaming-llm
description: Pattern for streaming LLM responses that are traditionally non-streaming (completeResponse) via onChunk callback, SSE, and generic doc events
source: auto-skill
extracted_at: '2026-06-23T22:49:58.155Z'
---

# Streaming Non-Streaming LLM Calls

Turn traditionally non-streaming LLM calls (like `completeResponse`) into streams so you can show progress to users instead of a blank ProcessingScreen while a 30s LLM call runs.

## The Problem

You have an LLM endpoint like `/end-chat`, `/epilogue`, or `/report-card` that:
- Calls `completeResponse()` (non-streaming, full response at the end)
- Takes 10–30 seconds
- Shows a blank "processing" state the whole time
- Users think the app is frozen

You also have chat endpoints using `streamResponse()` that already stream tokens to the user character-by-character. Why can't the other endpoints do that too?

## The Solution

Add an optional `onChunk` callback to `completeResponse()`. When provided, the client internally uses streaming (same as `streamResponse`), fires `onChunk` with each token, and still returns the full response at the end. Backend endpoints emit chunks via SSE or generic socket events (`DOC_CHUNK`/`DOC_DONE`). Frontend shows the streamed text progressively.

This keeps backward compatibility—callers that don't pass `onChunk` get the original non-streaming behavior.

## Implementation

### 1. Extend the LLM Client Interface

```typescript
interface LLMClient {
  // Add onChunk parameter to completeResponse
  completeResponse(
    system: string,
    userMessage: string,
    maxTokens?: number,
    role?: LLMRole,
    onChunk?: (chunk: string) => void  // <-- NEW
  ): Promise<string>;
}
```

### 2. Implement Both Paths

```typescript
async completeResponse(system: string, userMessage: string, 
    maxTokens = 1500, role?: LLMRole, onChunk?: (chunk: string) => void) {
  
  const msgs = [{ role: "system", content: system }, { role: "user", content: userMessage }];

  // If caller wants chunks, use the streaming API internally
  if (onChunk) {
    const stream = await client.chat.completions.create({
      model, max_tokens: maxTokens,
      stream: true, stream_options: { include_usage: true },
      messages: msgs,
    });
    
    let full = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        full += delta;
        onChunk(delta);
      }
    }
    return full;
  }

  // Default: non-streaming path (unchanged)
  const response = await client.chat.completions.create({
    model, max_tokens: maxTokens, messages: msgs,
  });
  return response.choices[0]?.message?.content ?? "";
}
```

### 3. Engine Layer Threads the Callback

```typescript
// ConversationEngine
async endFamilyChat(state: GameState, onChunk?: (chunk: string) => void) {
  const ctx = buildPsychologistContext(state);
  const doc = await this.llm.completeResponse(
    ctx.system, ctx.userMessage, undefined, "psychologist", onChunk  // <-- thread it
  );
  return transition(state, { type: "IDENTITY_UPDATED", document: doc });
}

// EndgameEngine
async generateEpilogue(state: GameState, onChunk?: (chunk: string) => void) {
  const ctx = buildEpilogueContext(state);
  const epilogue = await this.llm.completeResponse(
    ctx.system, ctx.userMessage, undefined, "epilogue", onChunk
  );
  return transition(state, { type: "START_EPILOGUE", epilogue });
}
```

### 4. Backend Routes Use Generic Doc Events

**Don't** create a separate event for each content type (`PSYCHOLOGIST_CHUNK`, `EPILOGUE_CHUNK`, `REPORT_CARD_CHUNK`). **Do** use a generic `DOC_CHUNK`/`DOC_DONE` pair:

```typescript
// REST endpoint streams via SSE
router.post("/game/:id/end-chat", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  
  const next = await engine.endFamilyChat(state, (chunk) => {
    res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`);
  });
  
  res.write(`data: ${JSON.stringify({ type: "done", phase: next.phase })}\n\n`);
  res.end();
});

// Socket endpoint uses generic DOC_CHUNK/DOC_DONE
socket.on("end_chat", async () => {
  const emitChunk = (chunk) => io.to(gameId).emit("doc_chunk", { text: chunk });
  const next = await engine.endFamilyChat(state, emitChunk);
  io.to(gameId).emit("doc_done", { documentType: "psychologist" });
});
```

Keep the protocol small. You have 3–5 doc types; don't bloat event names for each. The client knows which "flow" it's in from the current phase.

### 5. Frontend Consumes SSE or Socket Events

```typescript
// SSE helper
async function consumeSSE<T>(res: Response, onChunk: (text: string) => void): Promise<T> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "", donePayload: T | null = null;
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    lineBuffer += decoder.decode(value, { stream: true });
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";  // keep partial line
    
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === "chunk") onChunk(data.text);
        else if (data.type === "done") donePayload = data;
        else if (data.type === "error") throw new Error(data.error);
      } catch { /* partial line, skip */ }
    }
  }
  if (!donePayload) throw new Error("Stream ended without done event");
  return donePayload;
}

// Hook-level usage
const [streamingDocText, setStreamingDocText] = useState("");

const endChat = useCallback(async () => {
  setPhase("processing");
  setStreamingDocText("");
  const res = await fetch(`/game/${gameId}/end-chat`, { method: "POST" });
  let acc = "";
  const data = await consumeSSE<{ phase: string }>(res, (text) => {
    acc += text;
    setStreamingDocText(acc);
  });
  setStreamingDocText("");
  setPhase(data.phase);
}, [gameId]);
```

### 6. ProcessingScreen Shows Streaming Text Over Filler

When streaming text is available, show it. When not, fall back to rotating personality fragments:

```typescript
const [streamingDocText, setStreamingDocText] = useState("");

<ProcessingScreen 
  childName={childName} 
  age={currentEvent?.age} 
  streamingText={streamingDocText ? streamingDocText : undefined}
/>

// Inside ProcessingScreen
{streamingText ? (
  <div className="stream-text">{streamingText}</div>
) : (
  <span className="fragment">{fragments[fragmentIdx]}</span>
)}
```

The streaming text is itself the content. The rotating fragments are just fillers until streaming kicks in.

## Timeout Guidelines

| Call Type | Streaming? | Timeout |
|-----------|------------|--------|
| Chat messages (kid replies) | Yes | 60s (fast feedback) |
| Long docs (epilogue/psychologist) | Yes (with onChunk) | 120s (streaming so user sees progress) |
| Anything else | No (legacy path) | 90s |

Longer timeout is fine when the user sees progress. If streaming is working, they'll never feel a 90s wait—they'll see 10+ seconds of tokens flowing in.

## Why Generic DOC_CHUNK Instead of Per-Content Events

You might be tempted to emit `psychologist_chunk`, `epilogue_chunk`, `report_card_chunk`. Don't. Reasons:

1. **Protocol bloat** - Every new document type adds new events
2. **Client state** - The client already knows which "flow" it's in from `phase`
3. **Reusability** - Same hook/consumer works for all doc streams
4. **Future-proofing** - Adding a new document type (e.g. `adultChatSummary`) is free—just another call that emits `DOC_CHUNK`

Only include a `documentType` in `DOC_DONE` if clients actually need to distinguish completion events.

## When to Use This Pattern

- You have long-running (10s+) LLM calls where the user waits on a spinner
- You already have a chat/streaming flow using the same LLM provider
- You want to show the generated content as it produces
- You have a personality filler already in place (see companion skill: loading-states-with-personality)

## Companion Patterns

- **loading-states-with-personality** - What to show during waits
- **optimization-prefetch** - When to start work so waits are shorter

These combine: prefetch reduces actual wait, streaming shows progress, personality fillers cover whatever remains.

## Pitfalls to Avoid

1. **Don't forget JSON escaping** - Each chunk is JSON-stringified in the SSE data field
2. **Don't block the streaming loop on UI state updates** - Let React batch updates
3. **Don't stream into a modal that dismisses early** - Wait for the `done` event before transitioning phase
4. **Don't ignore the `done` payload** - It usually carries the final state (phase, full text)
5. **Don't skip the fallback** - If streaming fails mid-stream, the full response should still be returned
6. **Don't create per-doc-type events** - Keep the protocol generic with `DOC_CHUNK`/`DOC_DONE`

## Testing

- Unit test: mock LLM client's `onChunk` gets called with each chunk, then returns the full string
- Integration: hit an SSE endpoint, verify chunks arrive in order followed by a `done` event
- E2E: start a multi-player game where one player triggers streaming while another joins mid-stream—both sockets should see `doc_chunk` events

## Summary

The pattern is a thin layer:
```
onChunk (callback) → SSE (backend) → DOC_CHUNK (socket protocol) → streamingText (frontend state) → ProcessingScreen (UI)
```

It converts what the user experiences as a blank 30s spinner into an engaging 30s of watching the document write itself, with personality fragments filling in any gaps before the stream kicks in.
