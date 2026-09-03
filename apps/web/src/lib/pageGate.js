/**
 * A ceiling on how many third-party pages this process reads at once.
 *
 * ## The outage this exists to prevent
 *
 * Reading somebody else's page is the most expensive thing the directory does,
 * and it is expensive in the one dimension nothing else here bounds: memory.
 * `probePage` caps a download at 2 MB and `readableArticle` caps what it parses
 * at the same, so a *single* pass is bounded — but Readability runs over a DOM
 * that linkedom builds from that markup, and a parsed DOM is many times the
 * size of the bytes it came from. One pass is tens of megabytes at the top end.
 *
 * Nothing said how many could run at once, and "at once" is not the reader's
 * choice — it is whoever is asking. On 2026-09-02 that was a scraping fleet
 * presenting one desktop Chrome user-agent from many addresses, sustaining
 * ~14 requests a second against `/{slug}/read` for eight hours. Every request
 * was for a different post, so the extract cache never answered one of them,
 * and each arriving request started another fetch-and-parse while the ones
 * before it were still waiting on somebody's origin. The heap reached 3.9 GB in
 * about seven minutes, V8 gave up, the container restarted, and it happened
 * again — the site served 502 continuously until the traffic stopped.
 *
 * `crawlThrottle.js` could not prevent this and says so in its own header: it
 * meters a declared crawler by its token and everything else by address, and a
 * fleet that spoofs a browser across many addresses defeats both. That analysis
 * is right, and the conclusion drawn from it — that this needs blocking at the
 * edge — is also right, but it is not sufficient. A limiter keyed on *who is
 * asking* can always be evaded by asking from somewhere else. This one is keyed
 * on what the process is already doing, so it holds no matter who is at the
 * door, including for traffic that is entirely legitimate: a genuine spike of
 * real readers would have run the process out of memory in exactly the same
 * way, and that would have been much harder to explain.
 *
 * ## Why it refuses instead of queueing
 *
 * A queue would bound the parses and not the memory: every waiting request
 * still holds its connection, its context and whatever it has already read,
 * and under sustained load the queue is the leak. Refusing immediately keeps
 * the process's footprint flat at any arrival rate, which is the property that
 * was missing.
 *
 * The refusal is cheap for a reader to absorb because the page it falls back to
 * is one that already exists. A post whose page cannot be fetched shows its
 * summary, an honest notice and a link to the publisher — the same answer the
 * reader already gives for a timeout or a paywall. Under this gate a reader
 * sees that for a moment during a storm instead of seeing 502 for eight hours.
 *
 * ## Why a busy refusal is never written to the extract cache
 *
 * Because it is not a fact about the post. `lib/reader.js` stores failures
 * deliberately — a paywalled page should not be re-fetched on every view — and
 * storing "we were busy" would use that machinery to permanently deny an
 * article that was never actually tried. This is the same reasoning that keeps
 * the `stream` verdict out of the cache: nothing was attempted, so there is
 * nothing to remember. Callers get a reason of `busy` and must treat it as
 * transient.
 */

/**
 * How many passes may be in flight.
 *
 * Eight, because the bound that matters is the product of this number and the
 * worst-case size of one pass, and one pass can reach ~80 MB when a 2 MB page
 * parses into a large DOM. Eight of those is comfortably inside the container
 * while leaving room for everything else the process is doing, and it is far
 * above what the site's genuine concurrent readership has ever needed — the
 * cache answers a repeat view without coming here at all.
 */
const DEFAULT_LIMIT = 8;

/**
 * The limit, from the environment when it is set to something sensible.
 *
 * Read through a non-literal property access for the reason `lib/db.js` gives:
 * Next inlines `process.env.FOO` at build time, so a literal would freeze the
 * build's value into the image and ignore what Railway injects.
 *
 * Junk falls back to the default rather than to unlimited. That direction is
 * deliberate and it is the house rule the translation budget already follows:
 * a typo in a limit must not be the thing that removes the limit.
 *
 * @returns {number}
 */
function limit() {
  const env = process.env;
  const raw = Number(env['READER_CONCURRENCY']);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_LIMIT;
}

/** Passes currently running. */
let active = 0;

/**
 * Run `pass` if there is room, and `busy` if there is not.
 *
 * The counter is released in a `finally`, so a pass that throws frees its slot
 * — a gate that leaks slots on failure closes permanently, which would turn a
 * run of bad origins into the outage it exists to prevent.
 *
 * @template T
 * @param {() => Promise<T>} pass the fetch-and-extract to run
 * @param {() => T | Promise<T>} busy what to answer when the gate is full
 * @returns {Promise<T>}
 */
export async function withPageSlot(pass, busy) {
  if (active >= limit()) return busy();

  active += 1;
  try {
    return await pass();
  } finally {
    active -= 1;
  }
}

/**
 * What the gate is doing right now.
 *
 * Exposed so the state can be asserted in tests and reported by a health
 * endpoint if one ever wants it, rather than being inferred from behaviour.
 *
 * @returns {{ active: number, limit: number }}
 */
export function pageSlots() {
  return { active, limit: limit() };
}

/** Test seam. Never call this from a request path. @returns {void} */
export function reset() {
  active = 0;
}
