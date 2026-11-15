// app.ts — the entry's HTTP server. Routes:
//   GET  /healthz            boot probe (no auth)
//   /*.git/info/refs, git-upload-pack, git-receive-pack   git smart HTTP
//   /api/v3/*                REST v3
//   /api/graphql             GraphQL v4
//   /mcp                     MCP (Streamable HTTP)
// Auth: every route except /healthz requires Authorization: Bearer <token>
// where <token> is MAKEFUN_SHOP_TOKEN; a missing or wrong token is 401.
// (When the env var is unset, e.g. a bare local run, auth is skipped.)
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git-http.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { sendError, sendJson } from './http-util.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The shared empty body for GET/HEAD requests, which never carry one here. */
const EMPTY_BODY = Buffer.alloc(0);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let single: Buffer | null = null;
    let multi: Buffer[] | null = null;
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      // One chunk is the common case for the timed workloads' small bodies: keep
      // it as-is instead of copying it through Buffer.concat.
      if (single === null && multi === null) single = chunk;
      else {
        if (multi === null) multi = single === null ? [] : [single];
        single = null;
        multi.push(chunk);
      }
    });
    req.on('end', () => resolve(multi !== null ? Buffer.concat(multi) : (single ?? Buffer.alloc(0))));
    req.on('error', reject);
  });
}

/** Route one request whose body is already in hand. Runs synchronously: the four
 *  surfaces are all synchronous handlers, so a GET never pays for a promise. */
function dispatch(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const segments = url.pathname.split('/').filter((s) => s !== '');
  if (handleGit(req, res, body, url)) return;
  if (url.pathname === '/api/graphql' && req.method === 'POST') {
    handleGraphQL(req, res, body);
    return;
  }
  if (url.pathname === '/mcp') {
    handleMcp(req, res, body);
    return;
  }
  if (segments[0] === 'api' && segments[1] === 'v3') {
    handleRest({ req, res, body, url, segments });
    return;
  }
  sendError(res, 404, 'not found');
}

function fail(res: ServerResponse, err: unknown): void {
  if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'internal error');
  else res.end();
}

export function createApp(): Server {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = http.createServer((req, res) => {
    try {
      // /healthz is the unauthenticated boot probe: answer it before auth, on the
      // raw path (no URL object needed for this one check).
      const rawUrl = req.url ?? '/';
      const q = rawUrl.indexOf('?');
      const pathname = q < 0 ? rawUrl : rawUrl.slice(0, q);
      if (pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (expectedToken !== '') {
        const auth = req.headers.authorization ?? '';
        if (auth !== `Bearer ${expectedToken}`) {
          sendError(res, 401, 'unauthorized');
          return;
        }
      }
      // GET/HEAD never carry a body on any surface here: run the whole request
      // synchronously, with no promise and no extra event-loop turn.
      if (req.method === 'GET' || req.method === 'HEAD') {
        dispatch(req, res, EMPTY_BODY);
        return;
      }
      void readBody(req).then(
        (body) => {
          try {
            dispatch(req, res, body);
          } catch (err) {
            fail(res, err);
          }
        },
        (err) => fail(res, err),
      );
    } catch (err) {
      fail(res, err);
    }
  });
  return server;
}

export type { ServerResponse };
