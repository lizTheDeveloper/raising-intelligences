---
name: llm-latency-investigation
description: Systematic approach to diagnosing slow LLM API generations and implementing streaming/performance fixes through OpenRouter or OpenAI-compatible APIs
source: auto-skill
extracted_at: '2026-06-23T01:27:00.099Z'
---

# Diagnosing Slow LLM Generations (OpenRouter / OpenAI-compatible APIs)

When a user reports that LLM generations are slow, follow this investigation methodology. The goal is to identify which layer (network, API config, prompt design, or call orchestration) is adding latency.

## Step 1: Map the Call Topology

Find all files that make LLM API calls. Look for:
- API client initialization (base URL, SDK setup)
- Every call site — streaming vs non-streaming, model used, timeout settings
- Whether calls are sequential or parallel (`Promise.all`, etc.)
- The call chain: does one call's output feed into the next?

Key question: **Are calls that could run in parallel being forced into sequence?**

## Step 2: Check Prompt Caching

This is often the **highest-impact, lowest-effort** fix:
- Does the code send any `cache_control` markers on system prompts?
- Are system prompts stable across calls? (If the system prompt changes every call, caching won't help)
- For OpenRouter: is there a `provider` parameter with caching hints?
- Does the code use a fixed `seed` parameter? (enables some caching layers)

Look for repeated or near-identical system prompts across calls — these are prime cache candidates.

## Step 3: Analyze Context Growth

For each call type, check if the input context grows over time:
- Does the prompt include full conversation history that grows each turn?
- Are documents (identity docs, summaries, etc.) included in full and growing?
- Is there any truncation, summarization, or sliding window for older content?

**Growing context = growing latency** even if individual tokens are fast. Check context-assembler or prompt-builder functions to see if they include all historical data without bounds.

## Step 4: Streaming vs Non-Streaming

Identify which calls are non-streaming (`stream: false` or default):
- Non-streaming calls block entirely until the full response is ready
- For long outputs, this can mean 15-60+ seconds with zero user feedback
- The fix is often simple: switch to streaming and pipe chunks to the client via SSE, WebSocket, or socket.io

Pay special attention to calls that use expensive/slow models (quality-critical calls) — these are the ones where streaming would help most.

## Step 5: Timeout and Retry Configuration

Check:
- What are the timeout values? Are they excessively long (e.g., 180s)?
- Is there retry logic for transient failures (5xx, rate limits)?
- Is there exponential backoff or just instant failure?
- Are there circuit breakers or fallback models?

**Too-long timeouts** make the user wait forever. **No retries** mean a single transient failure crashes the operation.

## Step 6: Provider-Specific Routing

For OpenRouter specifically, check if the code passes:
- `provider` parameter with `allow_fallbacks: true` — lets OpenRouter route to alternative providers if the primary model is overloaded
- `route` parameter for model fallback chains

Without these, a temporarily overloaded model just fails instead of falling back.

## Step 7: Max Tokens

Check `max_tokens` for each call:
- Too high wastes time generating unnecessarily long responses
- Too low may cause truncation and retry loops
- Look for calls that don't specify `max_tokens` at all (SDK defaults may be too large)

## Reporting Findings

Rank findings by **impact x ease**:
1. Prompt caching (often 30-50% latency reduction, low effort)
2. Streaming non-streaming calls (perceived latency drops to near-zero)
3. Capping context growth (reduces per-call latency over time)
4. Fallback routing (reliability improvement)
5. Timeout tuning (fail faster, retry smarter)
6. Parallelism (where possible without breaking dependencies)

---

## Implementation: Adding Streaming to Non-Streaming Completions

When diagnosis identifies non-streaming calls as the main perceived-latency bottleneck, follow this layered pattern to add streaming without breaking the existing architecture.

### Layer 1: LLMClient Interface

Add an optional `onChunk` parameter to `completeResponse`:

```typescript
completeResponse(
  system: string,
  userMessage: string,
  maxTokens?: number,
  role?: LLMRole,
  onChunk?: (chunk: string) => void  // NEW: enables streaming
): Promise<string>;
```

Making it optional preserves backward compatibility — callers that don't need streaming pass nothing and get the same blocking behavior.

### Layer 2: OpenRouter Implementation

In `completeResponse`, branch on whether `onChunk` is provided:

```typescript
if (onChunk) {
  // Streaming path — same pattern as streamResponse
  const stream = await this.client.chat.completions.create({
    model, max_tokens: maxTokens,
    stream: true, stream_options: { include_usage: true },
    messages: [...],
  }, { signal: AbortSignal.timeout(120_000) });

  let fullResponse = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) { fullResponse += delta; onChunk(delta); }
  }
  return fullResponse;
}
// Non-streaming path unchanged
```

Use a **slightly longer timeout** for streaming (e.g., 120s vs 90s) because the user sees progress — they won't perceive the wait as harshly.

### Layer 3: Engine Threading

Thread `onChunk` through engines as an optional parameter:

```typescript
// ConversationEngine
async endFamilyChat(state: GameState, onChunk?: (chunk: string) => void): Promise<GameState> {
  // ...
  const updatedDoc = await this.llm.completeResponse(ctx.system, ctx.userMessage, undefined, "psychologist", onChunk);
  // ...
}

// EndgameEngine
async generateEpilogue(state: GameState, onChunk?: (chunk: string) => void) {
  // ...
  const epilogue = await this.llm.completeResponse(ctx.system, ctx.userMessage, undefined, "epilogue", onChunk);
  // ...
}
```

### Layer 4: REST Routes — Switch to SSE

Convert JSON endpoints to SSE:

```typescript
res.setHeader("Content-Type", "text/event-stream");
res.setHeader("Cache-Control", "no-cache");
res.setHeader("Connection", "keep-alive");

const result = await engine.generateEpilogue(state, (chunk) => {
  res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`);
});
// Persist state, then send done
res.write(`data: ${JSON.stringify({ type: "done", phase: result.state.phase, epilogue: result.epilogue })}\n\n`);
res.end();
```

Error path writes `{ type: "error", error: "..." }` then ends.

### Layer 5: Socket.IO Events

Add a generic `DOC_CHUNK` / `DOC_DONE` event pair distinct from existing `KID_CHUNK` / `MESSAGE_DONE`:

```typescript
socket.on(E.END_CHAT, async () => {
  const emitChunk = (chunk: string) => io.to(gameId).emit(E.DOC_CHUNK, { text: chunk });
  const next = await conversationEngine.endFamilyChat(state, emitChunk);
  // ... persist ...
  io.to(gameId).emit(E.DOC_DONE, { documentType: "identity" });
  broadcastState(gameId);
});
```

Using a separate event allows the client to distinguish kid-chunk (short, conversational) from doc-chunk (long-form document generation).

### Layer 6: Client-Side SSE Consumption

Create a reusable `consumeSSE<T>` helper:

```typescript
async function consumeSSE<T>(res: Response, onChunk: (text: string) => void): Promise<T> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let donePayload: T | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    lineBuffer += decoder.decode(value, { stream: true });
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === "chunk") onChunk(data.text);
        else if (data.type === "done") donePayload = data as T;
        else if (data.type === "error") throw new Error(data.error);
      } catch { /* partial SSE line — skip */ }
    }
  }
  if (!donePayload) throw new Error("Stream ended without done event");
  return donePayload;
}
```

The line-buffer pattern is critical — TCP can split in the middle of an SSE line, and `JSON.parse` on a partial line will throw.

### Layer 7: UI — Streaming on the Processing Screen

Instead of a blank spinner, accumulate and display streamed text:

```typescript
const [streamingDocText, setStreamingDocText] = useState("");

// In the SSE loop:
let docText = "";
const data = await consumeSSE(res, (text) => {
  docText += text;
  setStreamingDocText(docText);
});
setStreamingDocText(""); // clear when done
```

In the ProcessingScreen component, show `streamingText` when non-empty, otherwise show rotating placeholder fragments. This transforms a dead 15-30s wait into visible progress.

### Key Principles

1. **Optional parameter pattern** — `onChunk?: ...` keeps the interface backward-compatible. No breaking changes.
2. **Separate transport events** — `DOC_CHUNK`/`DOC_DONE` vs `KID_CHUNK`/`MESSAGE_DONE` lets clients render differently.
3. **Same SSE protocol for all endpoints** — `{ type: "chunk" | "done" | "error", ... }` is reusable across any generation endpoint.
4. **Longer timeout for streaming** — User sees progress so perceived wait is low; the actual time limit can be generous.
5. **Line buffer for SSE** — Always buffer partial lines; `JSON.parse` on a TCP-split line will crash.
