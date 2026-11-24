import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { TraceSink } from "../observability/langfuse.js";

/**
 * A local stand-in for Langfuse (RI_DEV_TRACE_FILE, see dev/harness.ts): the
 * same calls TracedLLMClient makes on the SDK, written as JSON lines.
 *
 *   {"type":"trace","id":…,"name":…,"tags":[…],"metadata":{…}}
 *   {"type":"generation","traceId":…,"name":…,"input":{…},"model":…,"metadata":{…}}
 *   {"type":"generation-end","traceId":…,"output":…}
 *
 * `jq -c 'select(.type=="trace") | .tags' <file>` lists every trace's tags.
 */
export class FileTraceSink implements TraceSink {
  constructor(private readonly file: string) {}

  private write(line: Record<string, unknown>): void {
    try {
      appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), ...line }) + "\n");
    } catch {
      // A dev convenience: never let a bad path break play.
    }
  }

  trace(body: { id?: string; name?: string; tags?: string[]; metadata?: unknown }) {
    const id = body.id ?? randomUUID();
    this.write({ type: "trace", ...body, id });
    return {
      generation: (g: Record<string, unknown>) => {
        this.write({ type: "generation", traceId: id, ...g });
        return { end: (e: Record<string, unknown> = {}) => this.write({ type: "generation-end", traceId: id, ...e }) };
      },
    };
  }

  async flushAsync(): Promise<void> {}
}
