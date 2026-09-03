import { createServer } from 'node:http';

import next from 'next';

import { admit, inflight } from './src/lib/loadShed.js';

/**
 * The HTTP server, with a ceiling on concurrent work.
 *
 * This replaces `next start`, and does one thing `next start` cannot: it
 * refuses a request when too many are already in flight. Reasoning, and the
 * outage that motivated it, in src/lib/loadShed.js. Everything else is what
 * `next start` does — the platform's PORT and HOSTNAME, Next's own request
 * handler, no options of our own.
 *
 * The port and host come from the environment and nothing else. Railway
 * injects PORT, and a hardcoded value here would leave the edge proxy
 * forwarding to a port nothing listens on — see the note in the Dockerfile.
 */

const port = Number(process.env.PORT) || 3000;
const hostname = process.env.HOSTNAME || '0.0.0.0';

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

/** Say so when refusing starts, and then once a minute while it goes on. */
let lastNoted = 0;

const server = createServer((req, res) => {
  const release = admit(pathOf(req.url));

  if (release === null) {
    refuse(res);
    return;
  }

  // `close` fires whether the response finished or the socket died under it,
  // which is the one event that means the request is no longer costing us.
  res.once('close', release);

  handle(req, res).catch((err) => {
    console.error('[web] request failed', err);
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
});

server.listen(port, hostname, () => {
  console.log(`[web] listening on http://${hostname}:${port}, in-flight cap ${inflight().limit}`);
});

/**
 * The refusal: 503, tiny, uncacheable, with a Retry-After a client can obey.
 *
 * Deliberately not the 429 the throttle sends. That one says "you are asking
 * too fast" and names the caller's tier and the rung above it; this one says
 * "the server is busy" and is addressed to nobody in particular, because the
 * caller it refuses may be an innocent reader who arrived during a storm.
 *
 * @param {import('node:http').ServerResponse} res
 */
function refuse(res) {
  const now = Date.now();
  if (now - lastNoted > 60_000) {
    lastNoted = now;
    const { active, limit, refused } = inflight();
    console.warn(`[web] shedding load: ${active}/${limit} in flight, ${refused} refused so far`);
  }

  res.writeHead(503, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'retry-after': '3',
  });
  res.end('The directory is busy right now. Try again in a moment.\n');
}

/**
 * The path of a request URL, without the query.
 *
 * `req.url` is the request-target as sent, which for an origin server is a
 * path — but a client may send an absolute form, and parsing it against a base
 * handles both.
 *
 * @param {string | undefined} url
 * @returns {string}
 */
function pathOf(url) {
  try {
    return new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}
