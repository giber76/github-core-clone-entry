// main.ts — the entry <-> env lifecycle, as the kit's wire contract settles it.
// The forge itself lives in app.ts; this file only runs it and talks to the env.
// Keep the shape: bind an ephemeral port, register it, poll until done, exit 0.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to
//      register with, so the program exits 1 at once.
//   2. The server binds listen(0) and the kernel picks a free port. Never bind
//      8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The first register wins; a
//      409 means another entry already registered, and this process waits like
//      any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers at once ({"done": false} while the suite runs), so this is a
//      poll with backoff, not a long-held request.
//   5. Close the server and exit 0.
//
// main.ts imports its own server and nothing else: no package, no Node built-in,
// no model call.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** One register or done request may take this long before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;
/** First wait between retries, and the longest wait. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 2_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential, capped at BACKOFF_MAX_MS. */
function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer and 409
 * means a first register already won, which is not this process's to fix. 400 and
 * 405 are contract errors and end the program; a network error or another status
 * is retried, since the env may still be starting.
 */
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await delay(backoffMs(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function awaitDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await delay(backoffMs(attempt));
  }
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await announce(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
