import type { GameEvent } from "../types.js";
import type { LLMClient } from "./client.js";

export class MockLLMClient implements LLMClient {
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

  async completeResponse(_system: string, _userMessage: string): Promise<string> {
    const response =
      this.identityUpdates[this.identityCallCount % this.identityUpdates.length];
    this.identityCallCount++;
    return response;
  }

  async completeJson<T>(_system: string, _userMessage: string): Promise<T> {
    const event = this.events.shift();
    if (!event) throw new Error("No mock events available");
    return event as unknown as T;
  }
}
