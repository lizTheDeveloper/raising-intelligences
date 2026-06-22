/**
 * Minimal HTTP helpers for the REST E2E test. Uses the global `fetch` against
 * the in-process server's real routes — no supertest, no mocking.
 */

export class RestClient {
  constructor(private readonly baseUrl: string) {}

  async post<T = unknown>(path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const res = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as T;
    return { status: res.status, json };
  }

  async get<T = unknown>(path: string): Promise<{ status: number; json: T }> {
    const res = await fetch(this.baseUrl + path);
    const json = (await res.json()) as T;
    return { status: res.status, json };
  }

  /**
   * Drive the SSE streaming /message endpoint: collect kid chunks and the final
   * `done` frame. Returns the assembled kid text plus messagesRemaining.
   */
  async sendMessage(
    gameId: string,
    sender: "parent1" | "parent2",
    content: string
  ): Promise<{ chunks: string; kidResponse: string; messagesRemaining: number }> {
    const res = await fetch(`${this.baseUrl}/api/game/${gameId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender, content }),
    });
    if (!res.body) throw new Error("No response body from /message");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let chunks = "";
    let kidResponse = "";
    let messagesRemaining = -1;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.replace(/^data:\s*/, "").trim();
        if (!line) continue;
        const evt = JSON.parse(line) as
          | { type: "chunk"; text: string }
          | { type: "done"; kidResponse: string; messagesRemaining: number }
          | { type: "error"; error: string };
        if (evt.type === "chunk") chunks += evt.text;
        else if (evt.type === "done") {
          kidResponse = evt.kidResponse;
          messagesRemaining = evt.messagesRemaining;
        } else if (evt.type === "error") throw new Error(`/message error: ${evt.error}`);
      }
    }

    return { chunks, kidResponse, messagesRemaining };
  }
}
