/**
 * The crawler's log, buffered on its way to the database.
 *
 * The daemon's log lines already go to stdout, where Railway keeps them and
 * nobody else can read them. /crawlstats streams the same lines to anybody
 * watching, which means writing them somewhere the web service can see — and
 * the crawl is the last thing that should be waiting on that write.
 *
 * So lines are recorded synchronously into memory and flushed on a timer, in one
 * batch. A crawl batch of twenty-five feeds becomes one round trip instead of
 * twenty-five, and a feed's crawl is never slowed by the log line describing it.
 */

/** How long a line may sit in memory before it is written. */
export const FLUSH_MS = 2000;

/**
 * Lines held before the oldest start being dropped.
 *
 * A cap rather than an unbounded queue: if Turso is unreachable the crawl keeps
 * running and keeps producing lines, and a log buffer is not worth an
 * out-of-memory kill. Dropping the oldest keeps the tail — which is the part a
 * live view is showing — and the count of what was dropped goes out with the
 * next successful flush, so a gap in the log says so.
 */
export const MAX_BUFFER = 500;

/**
 * One of the daemon's own log lines, as a row.
 *
 * The daemon logs whatever fields suit the event, so the mapping is generic:
 * the four columns that mean something to a reader are pulled out by name and
 * everything left over rides along as JSON in `detail`. Nothing is invented — a
 * line the renderer does not recognise still shows its event and its payload.
 *
 * `status` is left null for events that are neither good nor bad news, like
 * 'started': colouring a routine line green says something the line does not.
 *
 * @param {string} event
 * @param {object} fields
 * @returns {object}
 */
export function toEntry(event, fields = {}) {
  const { subject = null, slug = null, amount = null, ms = null, message, ...rest } = fields;

  return {
    event,
    status: /error$/.test(event) || message != null ? 'error' : null,
    subject: subject == null ? null : String(subject),
    slug: slug == null ? null : String(slug),
    amount: amount == null ? null : Number(amount),
    ms: ms == null ? null : Number(ms),
    detail: message != null ? String(message) : Object.keys(rest).length ? JSON.stringify(rest) : null,
  };
}

/**
 * A buffered writer for the crawler's log.
 *
 * `append` is injected rather than imported so this is testable without a
 * database, and so the caller owns the decision about where lines go.
 *
 * @param {{ append: (entries: object[]) => Promise<unknown>, flushMs?: number, maxBuffer?: number, onError?: (err: unknown) => void }} opts
 */
export function createRecorder({ append, flushMs = FLUSH_MS, maxBuffer = MAX_BUFFER, onError }) {
  let buffer = [];
  let timer = null;
  let flushing = false;
  let dropped = 0;
  let stopped = false;

  /**
   * Take a line for the log. Never throws, never blocks, never awaited.
   *
   * @param {object} entry
   */
  function record(entry) {
    if (stopped || !entry?.event) return;

    buffer.push({ at: new Date().toISOString(), ...entry });

    if (buffer.length > maxBuffer) {
      dropped += buffer.length - maxBuffer;
      buffer = buffer.slice(-maxBuffer);
    }

    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, flushMs);
      // The log must not be the reason the process stays alive.
      timer.unref?.();
    }
  }

  /**
   * Write everything buffered so far.
   *
   * Re-entrant by design: a flush already in flight keeps the new lines in the
   * buffer for the next one rather than interleaving two writes.
   *
   * @returns {Promise<number>} lines written
   */
  async function flush() {
    if (flushing || buffer.length === 0) return 0;
    flushing = true;

    const batch = buffer;
    buffer = [];

    // Announced before the lines it precedes, because that is where the gap
    // actually is. Counted out before the write so a failed flush does not
    // report the same gap twice.
    if (dropped > 0) {
      batch.unshift({
        at: batch[0].at,
        event: 'log-dropped',
        status: 'error',
        amount: dropped,
        detail: 'the log buffer overflowed; these lines were never written',
      });
      dropped = 0;
    }

    try {
      await append(batch);
      return batch.length;
    } catch (err) {
      // The lines are lost rather than retried: they are already on stdout, and
      // a retry queue that grows while the database is down is the failure this
      // buffer exists to avoid. The next flush will say a gap happened.
      dropped += batch.length;
      onError?.(err);
      return 0;
    } finally {
      flushing = false;
    }
  }

  /**
   * Stop accepting lines and write what is left.
   *
   * Called on shutdown so the last thing the log says is that the daemon
   * stopped, rather than trailing off mid-batch.
   *
   * @returns {Promise<number>}
   */
  async function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return flush();
  }

  return { record, flush, stop, pending: () => buffer.length };
}
