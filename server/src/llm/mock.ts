import type { GameEvent } from "../types.js";
import type { LLMClient } from "./client.js";
import type { LLMRole } from "./model-config.js";

export class MockLLMClient implements LLMClient {
  public kidResponses: string[] = ["I didn't mean to!"];
  public identityUpdates: string[] = ["Core beliefs: the world is safe."];
  public events: GameEvent[] = [];
  public epilogueText = "They grew up to be thoughtful.";
  public reportCardText = "# Luna\n## Personality\nThoughtful and kind.";
  public albumData: unknown = null;
  private kidCallCount = 0;
  private identityCallCount = 0;
  /** Roles the engine requested, in call order — useful for asserting routing. */
  public roleCalls: Array<LLMRole | undefined> = [];

  async streamResponse(
    _system: string,
    _messages: Array<{ role: string; content: string }>,
    onChunk: (chunk: string) => void,
    role?: LLMRole
  ): Promise<string> {
    this.roleCalls.push(role);
    const response = this.kidResponses[this.kidCallCount % this.kidResponses.length];
    this.kidCallCount++;
    for (const char of response) {
      onChunk(char);
    }
    return response;
  }

  async completeResponse(
    _system: string,
    _userMessage: string,
    _maxTokens?: number,
    role?: LLMRole,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    this.roleCalls.push(role);
    const response =
      this.identityUpdates[this.identityCallCount % this.identityUpdates.length];
    this.identityCallCount++;
    if (onChunk) {
      for (const char of response) onChunk(char);
    }
    return response;
  }

  async completeJson<T>(_system: string, _userMessage: string, role?: LLMRole): Promise<T> {
    this.roleCalls.push(role);
    if (role === "album" && this.albumData) return this.albumData as T;
    const event = this.events.shift();
    if (!event) throw new Error("No mock events available");
    return event as unknown as T;
  }
}
