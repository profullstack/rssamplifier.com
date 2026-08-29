import { spawn } from 'node:child_process';

/**
 * RSSHub, as a daemon inside this container rather than a service beside it.
 *
 * **Why here and not as its own Railway service.** The only thing in this system
 * that collects anything is this process. A separate service would mean a second
 * billed container, a private-networking hop, and a surface that has to be kept
 * unexposed — all to reach something that has exactly one consumer running in
 * the same place. On localhost none of that exists: no domain to forget to
 * remove, no IPv6 private-networking trap (Railway's outbound IPv6 is opt-in per
 * service and fails as a fast 504, which is a genuinely nasty thing to debug),
 * and nothing to bill.
 *
 * **It is supervised, and its death is never this process's death.** RSSHub is a
 * large third-party app talking to a hostile upstream; it will crash. A crash
 * must cost one restart and nothing else — not the crawl, not the queue, not the
 * 50,000 Reddit feeds that have nothing to do with X. So it is spawned detached
 * from the crawler's control flow, restarted with backoff, and if it never comes
 * up at all the crawler simply carries on: `fetchXSource` treats an unreachable
 * provider as a reschedule rather than as a verdict on the source (see the note
 * in packages/social/src/x/fetch.js, and PR #157 for what it cost to get that
 * wrong).
 *
 * **Nothing here is on the request path.** The web service never talks to
 * RSSHub — it never collects — so it needs none of this and gets none of it.
 */

/** Where the daemon listens. Loopback only: nothing outside the container. */
const HOST = '127.0.0.1';
const PORT = 1200;

/**
 * Where the image puts RSSHub, and what to run inside it.
 *
 * `dist/index.mjs` rather than a `bin` — the package publishes none, and their
 * own image starts it through an npm script. Reading that script is how this
 * path and the header size below were arrived at; guessing either produces a
 * daemon that starts and then fails on the first real request.
 */
const DEFAULT_ENTRY = '/opt/rsshub/dist/index.mjs';

/**
 * RSSHub's own start script raises this, and it is not decoration.
 *
 * A logged-in X request carries the session cookie in a header, and Node's
 * default 16KB header limit is smaller than what X sends back on some
 * endpoints. The failure is an opaque parse error partway through a response,
 * which reads like a broken upstream rather than a limit of ours.
 */
const NODE_OPTIONS = '--max-http-header-size=32768';

/**
 * Restart backoff, in milliseconds, by consecutive failure.
 *
 * Capped and short. RSSHub crashing repeatedly is a configuration problem — a
 * missing cookie, a changed upstream — and no amount of patience fixes it; the
 * backoff exists so that a crash loop costs a restart a minute rather than a
 * core, not because waiting longer is expected to help.
 */
const BACKOFF_MS = [1_000, 5_000, 15_000, 30_000, 60_000];

/**
 * A run that lasts this long is treated as a success, and resets the backoff.
 *
 * Without it a process that starts, serves for an hour and then dies is
 * indistinguishable from one that has never started, and would inherit the
 * backoff of a crash loop it is not in.
 */
const HEALTHY_AFTER_MS = 60_000;

/**
 * Start RSSHub and keep it running.
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   log?: (event: string, fields?: object) => void,
 *   spawn?: typeof spawn,
 *   now?: () => number,
 * }} [opts]
 * @returns {{ url: string, stop: () => Promise<void>, state: () => object }}
 */
export function startRsshub(opts = {}) {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const doSpawn = opts.spawn ?? spawn;
  const now = opts.now ?? (() => Date.now());

  const entry = String(env.RSSHUB_ENTRY ?? DEFAULT_ENTRY);
  const url = `http://${HOST}:${PORT}`;

  let child = null;
  let failures = 0;
  let stopping = false;
  let timer = null;
  let startedAt = 0;

  const start = () => {
    if (stopping) return;

    startedAt = now();
    child = doSpawn(process.execPath, [entry], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NODE_OPTIONS,
        PORT: String(PORT),
        // RSSHub binds every interface by default. Inside a worker service with
        // no public domain that is already unreachable, but saying loopback
        // explicitly means it stays unreachable if this service ever gains one.
        LISTEN_INADDR_ANY: '0',
        // In-memory cache. Redis is in this project and deliberately not used
        // here: it is the crawler's write queue, and handing a third-party app
        // the same instance to fill with route caches is a way to lose jobs to
        // an eviction policy nobody chose for them.
        CACHE_TYPE: 'memory',
        // The X login RSSHub collects with. Named differently on each side, so
        // the mapping is written down here rather than in an operator's head.
        TWITTER_AUTH_TOKEN: authTokens(env),
        ...(env.RSSHUB_ACCESS_KEY ? { ACCESS_KEY: String(env.RSSHUB_ACCESS_KEY) } : {}),
      },
      // Its own directory, because it resolves routes and configuration
      // relative to the application root rather than to the entry file.
      cwd: entry.replace(/\/dist\/[^/]+$/, ''),
      // Its output is its own; the crawler's log is not the place for a third
      // party's request lines. Errors are surfaced through the events below.
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    log('rsshub-started', { pid: child.pid, url });

    // Only the tail of stderr, and only on exit — RSSHub is chatty, and a live
    // pipe into the crawler's log buries the crawl.
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });

    child.on('error', (error) => {
      log('rsshub-error', { message: String(error?.message ?? error) });
    });

    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;

      const lived = now() - startedAt;
      if (lived >= HEALTHY_AFTER_MS) failures = 0;
      failures += 1;

      const wait = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
      log('rsshub-exited', {
        code,
        signal,
        livedMs: lived,
        failures,
        restartInMs: wait,
        // The last thing it said, truncated. Never its environment: that holds
        // the X session cookie.
        stderr: stderr.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300) || null,
      });

      timer = setTimeout(start, wait);
      timer.unref?.();
    });
  };

  start();

  return {
    url,

    state: () => ({ running: Boolean(child), pid: child?.pid ?? null, failures, url }),

    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      if (!child) return;

      const dying = child;
      dying.kill('SIGTERM');

      // A grace period, then insist. A supervisor that waits for ever on a
      // wedged child turns a deploy into a hung container, and Railway's own
      // patience is finite.
      await new Promise((resolve) => {
        const hard = setTimeout(() => {
          dying.kill('SIGKILL');
          resolve();
        }, 5_000);
        hard.unref?.();
        dying.on('exit', () => {
          clearTimeout(hard);
          resolve();
        });
      });
    },
  };
}

/**
 * Should this process run RSSHub itself?
 *
 * No when X is off — there is nothing to collect, and a daemon nobody calls is
 * memory and a crash loop waiting to be ignored. No when `RSSHUB_BASE_URL`
 * already names one, because somebody has pointed this at an instance they run
 * and taking that over would be surprising.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function shouldRunRsshub(env = process.env) {
  if (String(env.X_ENABLED ?? 'false').toLowerCase() === 'false') return false;
  if (String(env.RSSHUB_EMBEDDED ?? '').toLowerCase() === 'false') return false;
  return !String(env.RSSHUB_BASE_URL ?? '').trim();
}

/**
 * The X session cookies, in the spelling RSSHub wants.
 *
 * Ours is `X_SESSIONS` (structured JSON) because a positional pair of
 * comma-separated lists silently mispairs tokens with cookies — see
 * packages/social/src/x/sessions.js. RSSHub takes a bare comma-separated list of
 * `auth_token` values, so the translation happens here, once.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
export function authTokens(env) {
  const raw = String(env.X_SESSIONS ?? '').trim();

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const tokens = parsed
          .map((entry) => String(entry?.authToken ?? entry?.auth_token ?? '').trim())
          .filter(Boolean);
        if (tokens.length) return tokens.join(',');
      }
    } catch {
      // Falls through to the flat form rather than throwing: a malformed
      // X_SESSIONS must not stop the crawler booting.
    }
  }

  return String(env.X_AUTH_TOKENS ?? '').trim();
}
