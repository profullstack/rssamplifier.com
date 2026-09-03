/**
 * A ceiling on how many requests this process works on at once.
 *
 * ## The outage this exists to prevent
 *
 * On 2026-09-03 the site was down from 19:32 to 21:24 UTC. Traffic tripled in
 * an hour — 245,000 requests in fifty minutes, roughly 68 a second — and the
 * web process ran out of heap every seven minutes until the platform stopped
 * restarting it. The heap profile taken afterwards found no leak: module state
 * was 128 MB after a collection. What filled 4 GB was *work in progress*. At
 * 68 requests a second with a median response time of 8.5 seconds there were
 * close to six hundred requests in flight, each holding its database rows, its
 * render tree and its response buffers, and each collection pause made every
 * one of them slower and let more pile up behind it.
 *
 * The traffic itself was a fleet: 4,886 distinct addresses for 5,000 requests,
 * almost all of them used exactly once, presenting forty-odd mainstream browser
 * user-agents in even rotation. `crawlThrottle.js` meters a caller by what it
 * carries, and this caller carried nothing twice, so the throttle refused none
 * of it. `pageGate.js` bounds the reader's fetch-and-parse, and the fleet did
 * not use the reader — it walked topic pages and their feed exports, which are
 * cheap one at a time and fatal six hundred at a time.
 *
 * The lesson is the one `pageGate.js` already drew, applied to the whole
 * process rather than to one route: a limit keyed on *who is asking* can be
 * evaded by asking from somewhere else, and a limit keyed on *what the process
 * is already doing* cannot. This one holds for any caller, including a genuine
 * surge of real readers, which would have run the process out of memory in
 * exactly the same way.
 *
 * ## Why it refuses instead of queueing
 *
 * Node already queues: that is what the six hundred in-flight requests were.
 * A queue bounds nothing — every waiting request still holds its connection
 * and its context, and under sustained load the queue *is* the memory. Above
 * the ceiling this answers 503 immediately, before Next has looked at the
 * request, which costs a few microseconds and no allocation worth naming. The
 * requests that are admitted then finish at the speed the process can actually
 * manage, instead of all of them finishing at the speed of a process that is
 * mostly collecting garbage.
 *
 * ## Why this lives in front of Next, not in the proxy
 *
 * The proxy sees a request begin and never sees it end — it returns
 * `NextResponse.next()` and the page renders afterwards — so it cannot count
 * what is in flight. Only the HTTP server that owns the response knows when
 * the response is finished. `server.mjs` is that server; this module is the
 * counter it consults, kept apart so the decision can be tested without
 * standing Next up.
 */

/**
 * How many requests may be in flight.
 *
 * Sized from the incident: the process survived an hour at roughly 20 a
 * second with sub-second responses, which is fewer than twenty in flight, and
 * died at six hundred. A hundred and twenty-eight is far above anything the
 * site's real readership has produced and far below where the heap went; at
 * that depth a request that takes two seconds still gets served, and the
 * process's footprint is bounded at the cap times one request's worth of
 * work — tens of megabytes at the top end — rather than at whatever the
 * arrival rate happens to be.
 */
const DEFAULT_LIMIT = 128;

/**
 * Served whatever the load: the build's own assets and the handful of files a
 * page load pulls alongside its document.
 *
 * Refusing these under load would break the page for the reader who *was*
 * admitted — a document whose stylesheet got a 503 is not a served page — and
 * they cost nothing worth counting: static files off disk, no database, no
 * render. The same set the proxy's matcher leaves out, for the same reason.
 */
const ALWAYS = /^\/(?:_next\/static\/|icons\/|favicon\.ico$|manifest\.webmanifest$|sw\.js$|robots\.txt$)/;

/**
 * The limit, from the environment when it is set to something sensible.
 *
 * Read through a non-literal property access for the reason `lib/db.js` gives,
 * and junk falls back to the default rather than to unlimited, for the reason
 * `pageGate.js` gives: a typo in a limit must not be the thing that removes it.
 *
 * @returns {number}
 */
export function limit() {
  const env = process.env;
  const raw = Number(env['WEB_MAX_INFLIGHT']);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_LIMIT;
}

/** Requests currently being worked on. */
let active = 0;

/** Requests refused since the process started. */
let refused = 0;

/**
 * Ask to work on a request.
 *
 * Returns the function to call when the response is finished, or `null` when
 * the process is full and the request should be refused. Release is idempotent
 * — a server wires it to the response's `close` event, and an event that fired
 * twice must not free a slot twice, or the counter drifts negative and the cap
 * silently rises.
 *
 * @param {string} pathname
 * @returns {(() => void) | null}
 */
export function admit(pathname) {
  if (ALWAYS.test(pathname)) return () => {};

  if (active >= limit()) {
    refused += 1;
    return null;
  }

  active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
  };
}

/**
 * What the counter is doing right now.
 *
 * @returns {{ active: number, limit: number, refused: number }}
 */
export function inflight() {
  return { active, limit: limit(), refused };
}

/** Test seam. Never call this from a request path. @returns {void} */
export function reset() {
  active = 0;
  refused = 0;
}
