import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for a self-hosted Langfuse, over real HTTP, for tests that need
 * to see exactly what the server sends. The real `langfuse` SDK talks to it:
 *
 *   POST /api/public/ingestion   batches of trace-create / generation-create /
 *                                generation-update events, as the SDK sends them.
 *                                Trace upserts merge by id, tags as a union, as
 *                                Langfuse does (holdGameTraces relies on it).
 *   GET  /api/public/traces      ?tags=<tag>&limit&page, the read API that
 *                                holdGameTraces, scripts/model-search.ts and the
 *                                ri-devlog skill use.
 *
 * `use()` points the LANGFUSE_* env vars at it; restore() puts them back.
 */
export interface SinkTrace {
  id: string;
  name?: string;
  tags: string[];
  metadata?: Record<string, unknown>;
}

export interface SinkGeneration {
  id: string;
  traceId: string;
  name?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export class LangfuseSink {
  readonly traces = new Map<string, SinkTrace>();
  readonly generations: SinkGeneration[] = [];
  /** Every request body the SDK posted, verbatim, for wire-level checks. */
  readonly raw: string[] = [];
  private server!: http.Server;
  private saved: Record<string, string | undefined> = {};
  url = "";

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => this.handle(req, res, body));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  use(): void {
    for (const k of ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASEURL", "LANGFUSE_HOST"]) this.saved[k] = process.env[k];
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_BASEURL = this.url;
    delete process.env.LANGFUSE_HOST;
  }

  restore(): void {
    for (const [k, v] of Object.entries(this.saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  async stop(): Promise<void> {
    this.restore();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  clear(): void {
    this.traces.clear();
    this.generations.length = 0;
    this.raw.length = 0;
  }

  tracesOf(gameId: string): SinkTrace[] {
    return [...this.traces.values()].filter((t) => t.tags.includes(`game_id:${gameId}`));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    const url = new URL(req.url ?? "/", this.url);
    if (req.method === "POST" && url.pathname === "/api/public/ingestion") {
      this.raw.push(body);
      const parsed = JSON.parse(body) as { batch?: Array<{ id: string; type: string; body: Record<string, any> }> };
      for (const ev of parsed.batch ?? []) this.ingest(ev.type, ev.body);
      res.writeHead(207, { "content-type": "application/json" });
      res.end(JSON.stringify({ successes: (parsed.batch ?? []).map((e) => ({ id: e.id, status: 201 })), errors: [] }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/public/traces") {
      const tag = url.searchParams.get("tags");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const page = Number(url.searchParams.get("page") ?? 1);
      const all = [...this.traces.values()].filter((t) => !tag || t.tags.includes(tag));
      const data = all.slice((page - 1) * limit, page * limit);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data, meta: { page, limit, totalItems: all.length } }));
      return;
    }
    res.writeHead(404);
    res.end();
  }

  private ingest(type: string, body: Record<string, any>): void {
    if (type === "trace-create") {
      const prev = this.traces.get(body.id);
      const tags = [...new Set([...(prev?.tags ?? []), ...((body.tags as string[] | undefined) ?? [])])];
      this.traces.set(body.id, { ...prev, ...body, id: body.id, tags });
    } else if (type === "generation-create") {
      this.generations.push({ id: body.id, traceId: body.traceId, name: body.name, input: body.input, metadata: body.metadata });
    }
  }
}
