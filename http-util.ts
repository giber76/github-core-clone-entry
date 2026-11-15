// http-util.ts — small response helpers shared by the four surfaces.
// Perf notes: the timed workloads are thousands of tiny requests, so the helpers
// avoid per-call Date work — request ids come from a counter, and the ISO clock
// string is refreshed only when the wall second rolls over.
import type { ServerResponse } from 'node:http';

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** The current time as an ISO string, cached for the running wall second. */
let cachedSecond = -1;
let cachedIso = '';
export function nowIso(): string {
  const second = Math.floor(Date.now() / 1000);
  if (second !== cachedSecond) {
    cachedSecond = second;
    cachedIso = new Date(second * 1000).toISOString();
  }
  return cachedIso;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

export function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}
