/**
 * The interface the ConversationEngine depends on. Both the real Claude client
 * and the mock implement this. Keeping it narrow (three primitives) means the
 * engine never has to know which roles map to streaming vs. completion calls.
 */
export interface LLMClient {
  streamResponse(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk: (chunk: string) => void
  ): Promise<string>;

  completeResponse(system: string, userMessage: string, maxTokens?: number): Promise<string>;

  completeJson<T>(system: string, userMessage: string): Promise<T>;
}
