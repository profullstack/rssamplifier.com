import { createServer } from 'node:http';

import next from 'next';

import { admit, inflight } from './src/lib/loadShed.js';
import { forkWorkers, workerCount } from './src/lib/workers.js';

/**
 * The HTTP server, on every core, with a ceiling on concurrent work.
 *
 * This replaces `next start`, and does two things `next start` cannot. It
 * refuses a request when too many are already in flight — reasoning, and the
 * outage that motivated it, in src/lib/loadShed.js. And it runs one copy of the
 * server per CPU the container is allowed, because JavaScript renders a page on
 * one thread and a single copy leaves the rest of the machine idle while the
 * site is down — reasoning, and *that* outage, in src/lib/workers.js.
 *
 * Everything else is what `next start` does — the platform's PORT and HOSTNAME,
 * Next's own request handler, no options of our own.
 *
 * The port and host come from the environment and nothing else. Railway
 * injects PORT, and a hardcoded value here would leave the edge proxy
 * forwarding to a port nothing listens on — see the note in the Dockerfile.
 *
 * Every worker listens on the same port; `node:cluster` gives the primary the
 * socket and hands connections round-robin. Nothing below needs to know whether
 * it is the only server or one of sixteen, with one exception worth naming: all
 * of the module state behind these requests — the throttle's counters, the
 * traffic tally, the verified-key cache — is now per worker rather than per
 * container. For the counters that bound *memory* that is the correct place for
 * them, and `loadShed` divides its allowance so the container-wide total is
 * unchanged. For the counters that meter *a caller* it is a loosening: a client
 * holding a keep-alive connection stays on one worker, so its own limit is
 * intact, but a caller opening fresh connections is metered by each worker
 * separately. That is deliberate. The traffic this was written for arrives one
 * request per address and defeats a per-caller limit outright, and tightening
 * those limits by a factor of sixteen during an outage would refuse readers to
 * no purpose. See src/lib/workers.js on why capacity is not a defence.
 */

const port = Number(process.env.PORT) || 3000;
const hostname = process.env.HOSTNAME || '0.0.0.0';

// The primary forks and then has nothing to do. It must not go on to stand up
// Next and bind the port itself: that would put a seventeenth server on the
// socket with none of the workers' heap settings.
if (
  forkWorkers({
    onExit: ({ pid, code, signal }) => {
      console.warn(`[web] worker ${pid} exited (code ${code}, signal ${signal}), replacing it`);
    },
  })
) {
  console.log(`[web] primary ${process.pid} running ${workerCount()} workers`);
} else {
  await serve();
}

/**
 * Stand up Next and answer requests until the process ends.
 *
 * @returns {Promise<void>}
 */
async function serve() {
  const app = next({ dev: false, hostname, port });
  const handle = app.getRequestHandler();

  await app.prepare();

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
    console.log(
      `[web] ${process.pid} listening on http://${hostname}:${port}, in-flight cap ${inflight().limit}`,
    );
  });
}

/** Say so when refusing starts, and then once a minute while it goes on. */
let lastNoted = 0;

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
    console.warn(
      `[web] ${process.pid} shedding load: ${active}/${limit} in flight, ${refused} refused so far`,
    );
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
