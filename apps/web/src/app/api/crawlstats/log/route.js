import { q } from '@rssamplifier/db';

import { db } from '../../../../lib/db.js';
import { frame, line, stream, TEXT_STREAM_HEADERS } from '../../../../lib/sse.js';
import { textLine, toLine } from '../../../../lib/crawlLog.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

/** Lines sent on connect, so a stream joined mid-crawl is not blank. */
const BACKLOG = 60;

/** Lines sent per tick. A cap, not a target: the crawler outruns it only after an outage. */
const PER_TICK = 200;

/**
 * How long the stream may say nothing before it says nothing on purpose.
 *
 * A crawler with nothing due sends no bytes, and a proxy between here and the
 * reader is entitled to conclude a silent connection is a dead one. A comment
 * every twenty seconds is invisible to EventSource and greppable-out of the text
 * form, and it keeps the connection honest.
 */
const HEARTBEAT_MS = 20_000;

/**
 * The crawler's log, live.
 *
 * The numbers on /crawlstats are a dashboard: they say what the directory looks
 * like now and what it got through last hour. This is the other half — what the
 * crawler is doing this second, feed by feed. The poller writes the lines as it
 * works (it is a separate service, so the database is the only thing the two
 * share) and this reads forward from a cursor.
 *
 * Two shapes, one loop:
 *
 *   /api/crawlstats/log              server-sent events, for the page
 *   /api/crawlstats/log?format=text  a log file that keeps being written
 *
 * The second is the one worth knowing about: `curl -N` on it tails the crawler
 * from anywhere, which is what a log is for.
 *
 * The cursor is a row id. SSE clients never have to send it — each frame carries
 * its id and the browser returns it as `Last-Event-ID` on reconnect — so a tab
 * left open all day misses nothing and repeats nothing.
 *
 * @param {Request} req
 */
export async function GET(req) {
  const url = new URL(req.url);
  const client = db();
  const asText = url.searchParams.get('format') === 'text';

  // Last-Event-ID first: it is the browser telling us where its own connection
  // actually broke, which beats what the page knew when it rendered.
  const resumed = req.headers.get('last-event-id');
  const asked = resumed ?? url.searchParams.get('since');
  let cursor = /^\d+$/.test(String(asked ?? '')) ? Number(asked) : null;

  const backlog = clamp(url.searchParams.get('backlog'), BACKLOG, 0, 500);
  let idle = Date.now();

  return stream(
    async (first) => {
      // A fresh connection with no cursor starts from the recent past rather
      // than from an empty screen: the log's value is what just happened, and
      // waiting a tick to find out is a page that looks broken. `backlog=0` is
      // the opposite request — the future only — and it still costs one read,
      // because the newest line is what tells us where the future starts.
      let rows;
      if (first && cursor == null) {
        const tail = await q.crawlLogTail(client, Math.max(backlog, 1));
        cursor = tail.length > 0 ? Number(tail.at(-1).id) : 0;
        rows = backlog === 0 ? [] : tail;
      } else {
        rows = await q.crawlLog(client, { since: cursor ?? 0, limit: PER_TICK });
      }

      const frames = [];

      for (const row of rows) {
        const entry = toLine(row);
        frames.push(asText ? line(textLine(entry)) : frame('log', entry, entry.id));
        cursor = entry.id;
      }

      if (frames.length > 0) {
        idle = Date.now();
      } else if (Date.now() - idle > HEARTBEAT_MS) {
        idle = Date.now();
        frames.push(asText ? line('# nothing to report') : frame('ping', { at: new Date().toISOString() }));
      }

      // Never done: the crawler does not finish. The stream is retired by its own
      // deadline instead, and the client comes back with its cursor.
      return { frames, done: false };
    },
    asText
      ? {
          headers: TEXT_STREAM_HEADERS,
          end: (reason) =>
            // Said in the log rather than swallowed, because a terminal has no
            // other way to tell a retired connection from a stalled crawler.
            line(
              reason.reason === 'reconnect'
                ? '# stream closed after 10 minutes — reconnect to keep reading'
                : `# stream ended: ${reason.message ?? reason.reason}`,
            ),
        }
      : undefined,
  );
}

/**
 * A query-string number, or the default.
 *
 * The absent case is checked before the conversion, because `Number(null)` is 0
 * rather than NaN — which silently turned "no backlog asked for" into "no
 * backlog wanted" and opened every stream on a blank screen.
 *
 * @param {string|null} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, fallback, min, max) {
  if (value == null || value === '') return fallback;

  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.trunc(n), max));
}
