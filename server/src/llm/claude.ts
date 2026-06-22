import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient } from "./client.js";

export class ClaudeLLMClient implements LLMClient {
  private client: Anthropic;
  private model = "claude-sonnet-4-20250514";

  constructor() {
    this.client = new Anthropic();
  }

  async streamResponse(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    const promptMessages =
      messages.length > 0
        ? messages
        : [
            {
              role: "user" as const,
              content: "(The child looks at their parents, waiting.)",
            },
          ];

    let fullResponse = "";

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 500,
      system,
      messages: promptMessages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        fullResponse += event.delta.text;
        onChunk(event.delta.text);
      }
    }

    return fullResponse;
  }

  async completeResponse(system: string, userMessage: string, maxTokens = 1500): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = response.content[0];
    if (block && block.type === "text") return block.text;
    throw new Error("Unexpected response type");
  }

  async completeJson<T>(system: string, userMessage: string): Promise<T> {
    const text = await this.completeResponse(system, userMessage, 500);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    return JSON.parse(jsonMatch[0]) as T;
  }
}
