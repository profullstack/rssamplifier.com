import { opmlHead, opmlOutline, opmlFoot } from '@rssamplifier/feed';
import { q } from '@rssamplifier/db';

import { db } from '../../lib/db.js';
import { slugFromUrl } from '../../lib/topicGroups.js';

export const dynamic = 'force-dynamic';

/**
 * The whole directory as an OPML subscription list.
 *
 * Load it into any feed reader, or hand it to an agent as a single artifact.
 *
 * "Whole" is the contract, so this has no row cap: it used to stop at 5,000 of
 * the ~48,000 blogs, which is worse than a smaller directory because the file
 * looks complete — it is sorted by title, so the truncation reads as a
 * directory that simply ends midway through the alphabet.
 *
 * The response is streamed from a paged cursor rather than assembled first,
 * and — this is the part that was wrong until 2026-09-03 — it is pulled, not
 * pushed. The previous version enqueued every outline from inside `start()`,
 * as fast as the database could page them, and a ReadableStream's `enqueue`
 * never blocks: whatever the client had not yet read sat in the stream's
 * internal queue. The whole 70 MB document was resident per request, held
 * for the sixty-odd seconds the cursor took, and held just the same for a
 * client that had already hung up, because nothing told the loop to stop. A
 * handful of overlapping exports was a gigabyte.
 *
 * Under `pull()` the runtime asks for the next chunk only when the consumer
 * has taken the last one, so the queue holds one chunk, the cursor advances at
 * the client's pace, and `cancel()` — which fires when the client goes away —
 * closes the cursor. Nothing larger than one page is resident, the reader
 * starts receiving outlines immediately, and the cost of the endpoint stops
 * scaling with the size of the directory, which is what the old comment
 * claimed and the old code did not deliver.
 *
 * `?limit=` caps the export for callers that want a sample instead, and
 * `?kind=blog` / `?kind=podcast` exports one category — which is the form a
 * podcast app actually wants, since it has no use for forty thousand blogs.
 *
 * `?topic=homelab` exports one topic, and is the cut most consumers actually
 * want. A reader that loads all fifty thousand feeds has subscribed to the
 * whole web; the interesting artifact is "the hundred-odd feeds about the thing
 * I care about", which is small enough to hand to a reader, an agent or another
 * tool's subscription list without it becoming that tool's whole world. The
 * keyword is normalised the same way /topics/<keyword> normalises it, so a
 * caller can pass the phrase it read rather than having to know the slug.
 */
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const limit = parseLimit(params.get('limit'));
  const kind = q.normalizeKind(params.get('kind'));
  const rawTopic = params.get('topic');
  // An empty or punctuation-only ?topic= slugs to '', which must mean "no
  // topic" rather than "the topic whose slug is the empty string" — the latter
  // matches nothing and would export an empty list that looks like a dead
  // directory.
  const topic = rawTopic ? slugFromUrl(rawTopic) || null : null;
  const client = db();

  const title = topicTitle(topic, kind);
  const filename = topic
    ? `rssamplifier-${topic}.opml`
    : kind
      ? `rssamplifier-${kind}s.opml`
      : 'rssamplifier.opml';

  const stream = opmlStream(q.eachFeedForExport(client, 2000, { kind, topic }), { title, limit });

  return new Response(stream, {
    headers: {
      'content-type': 'text/x-opml+xml; charset=utf-8',
      'content-disposition': `inline; filename="${filename}"`,
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=600',
    },
  });
}

/**
 * How many outlines go into one chunk.
 *
 * One row per pull would work and would cost a promise per outline over a
 * third of a million outlines; a few hundred at a time keeps the chunk at
 * tens of kilobytes, which is a sensible unit to hand a socket, while keeping
 * what is resident to a few hundred rows plus the cursor's current page.
 */
const OUTLINES_PER_CHUNK = 500;

/**
 * The OPML document as a stream that advances at the reader's pace.
 *
 * Exported for the test, which drives it with a consumer that stops reading
 * and a cursor that counts how far it was asked to go — the property that
 * matters is not what comes out, which is the same document as before, but
 * that nothing comes out of the cursor until somebody is ready for it.
 *
 * @param {AsyncIterator<{ title?: unknown, feed_url?: unknown, site_url?: unknown }>} rows
 * @param {{ title: string, limit: number|null }} options
 * @returns {ReadableStream<Uint8Array>}
 */
export function opmlStream(rows, { title, limit }) {
  const encoder = new TextEncoder();
  let opened = false;
  let closed = false;
  let written = 0;

  /** @param {ReadableStreamDefaultController<Uint8Array>} controller */
  const finish = (controller) => {
    if (closed) return;
    closed = true;
    controller.enqueue(encoder.encode(opmlFoot()));
    controller.close();
  };

  return new ReadableStream({
    async pull(controller) {
      if (!opened) {
        opened = true;
        controller.enqueue(encoder.encode(opmlHead(title)));
        return;
      }
      if (closed) return;

      let chunk = '';
      let count = 0;
      let exhausted = false;
      try {
        while (count < OUTLINES_PER_CHUNK) {
          if (limit !== null && written >= limit) {
            exhausted = true;
            break;
          }

          const { value: row, done } = await rows.next();
          if (done) {
            exhausted = true;
            break;
          }

          chunk += `${opmlOutline({
            title: String(row.title ?? ''),
            feed_url: String(row.feed_url ?? ''),
            site_url: row.site_url ? String(row.site_url) : null,
          })}\n`;
          written += 1;
          count += 1;
        }
      } catch (err) {
        // The head is already on the wire, so the response cannot become an
        // error status. Close out a well-formed document instead of tearing the
        // connection down mid-element and handing readers a parse error — a
        // short list beats an unparseable one.
        console.error('opml export failed partway', err);
        exhausted = true;
      }

      if (chunk) controller.enqueue(encoder.encode(chunk));
      if (exhausted) finish(controller);
    },

    // The client went away. Close the cursor so the database is not asked for
    // the rest of a directory nobody is reading.
    async cancel() {
      closed = true;
      await rows.return?.();
    },
  });
}

/**
 * The OPML document's own title, which is what a reader files the import under.
 *
 * Worth naming precisely: several of these imported into one reader are
 * otherwise several folders all called "RSS Amplifier".
 *
 * @param {string|null} topic
 * @param {string|null} kind
 * @returns {string}
 */
function topicTitle(topic, kind) {
  if (topic && kind) return `RSS Amplifier — ${topic} (${kind}s)`;
  if (topic) return `RSS Amplifier — ${topic}`;
  if (kind) return `RSS Amplifier — ${kind}s`;
  return 'RSS Amplifier — full directory';
}

/**
 * @param {string|null} raw
 * @returns {number|null} null when unset or unusable, meaning "no cap"
 */
function parseLimit(raw) {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}
