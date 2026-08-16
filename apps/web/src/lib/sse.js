/**
 * Server-sent events for the two status pages.
 *
 * Both pages watch a queue drain, and both already have every fact they need in
 * the database — what they lacked was anything telling the browser that a fact
 * had changed. Polling a JSON endpoint every second would do it, but it makes
 * the page's liveliness a property of the client's timer rather than of the
 * work, and it re-sends the whole run each tick.
 *
 * SSE inverts that: one connection, and a line goes out when something actually
 * happened. It is deliberately not a WebSocket — nothing is ever sent upstream,
 * and EventSource reconnects by itself, which is most of what a socket would
 * have cost us to write.
 */

/**
 * How often the stream looks for new work to report.
 *
 * A second is fast enough to feel immediate and slow enough that a watched run
 * costs a couple of small indexed queries per second. Both underlying queries
 * are bounded by `since`, so a quiet run costs two empty reads.
 */
export const TICK_MS = 1000;

/**
 * How long one connection lives before the client is asked to reconnect.
 *
 * A stream that never ends is a connection leaked per abandoned tab. Ending it
 * deliberately is cheap because EventSource reconnects on its own and each of
 * these streams resumes from a cursor, so a reconnect costs one query and
 * nothing is missed or repeated.
 */
export const MAX_STREAM_MS = 10 * 60 * 1000;

/**
 * The stream URL for a page that has already rendered some of the log.
 *
 * Half of the cursor convention lives here: the page says what it last showed
 * and the stream answers with what came after. Getting this wrong is not subtle
 * — the whole visible history reappears underneath itself.
 *
 * @param {string} path
 * @param {Array<{ at?: unknown }>} lines already on the page, oldest first
 * @returns {string}
 */
export function streamSrc(path, lines) {
  const newest = lines.at(-1)?.at;
  return newest ? `${path}?since=${encodeURIComponent(String(newest))}` : path;
}

const encoder = new TextEncoder();

/**
 * Format one SSE frame.
 *
 * @param {string} event
 * @param {unknown} data
 * @returns {Uint8Array}
 */
export function frame(event, data) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Headers that keep a stream a stream.
 *
 * `x-accel-buffering` is the load-bearing one in production: a buffering proxy
 * in front of the app will happily hold a second's worth of events and deliver
 * them in a lump, which looks exactly like the page being broken.
 */
export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  'access-control-allow-origin': '*',
};

/**
 * Run a polling loop as an SSE response.
 *
 * `poll` is called every tick and returns the frames to send plus whether the
 * work is finished; returning `done` ends the stream after those frames, so the
 * last update always goes out before the close.
 *
 * @param {(first: boolean) => Promise<{ frames: Uint8Array[], done: boolean }>} poll
 * @returns {Response}
 */
export function stream(poll) {
  let cancelled = false;

  const body = new ReadableStream({
    async start(controller) {
      const deadline = Date.now() + MAX_STREAM_MS;
      let first = true;

      try {
        while (!cancelled) {
          const { frames, done } = await poll(first);
          first = false;

          for (const chunk of frames) {
            if (cancelled) break;
            controller.enqueue(chunk);
          }

          if (cancelled) break;

          if (done) {
            controller.enqueue(frame('end', { reason: 'complete' }));
            break;
          }

          if (Date.now() > deadline) {
            // Not an error: the client reconnects from its cursor.
            controller.enqueue(frame('end', { reason: 'reconnect' }));
            break;
          }

          await sleep(TICK_MS);
        }
      } catch (err) {
        // A failed query should say so rather than look like a finished run.
        if (!cancelled) {
          controller.enqueue(frame('end', { reason: 'error', message: String(err?.message ?? err) }));
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed because the client went away first.
        }
      }
    },

    cancel() {
      // The tab closed. Stop querying on its behalf.
      cancelled = true;
    },
  });

  return new Response(body, { headers: SSE_HEADERS });
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
