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
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        if (url.pathname === '/healthz') {
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
        // GET/HEAD never carry a body on any surface here: skip the read (and the extra
        // event-loop turn waiting for 'end') and hand the handlers an empty buffer.
        const body = req.method === 'GET' || req.method === 'HEAD' ? EMPTY_BODY : await readBody(req);
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
      } catch (err) {
        if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'internal error');
        else res.end();
      }
    })();
  });
  return server;
}

export type { ServerResponse };
