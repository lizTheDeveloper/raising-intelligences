import type { Response } from "express";

export function initSSE(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
}

export function sseChunk(res: Response, text: string): void {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: "chunk", text })}\n\n`);
}

export function sseDone(res: Response, payload: Record<string, unknown>): void {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ type: "done", ...payload })}\n\n`);
    res.end();
  }
}

export function sseError(res: Response, error: string): void {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ type: "error", error })}\n\n`);
    res.end();
  }
}
