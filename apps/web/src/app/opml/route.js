import { opmlHead, opmlOutline, opmlFoot } from '@rssamplifier/feed';
import { q } from '@rssamplifier/db';

import { db } from '../../lib/db.js';

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
 * The response is streamed from a paged cursor rather than assembled first.
 * Nothing larger than one page is ever resident, the reader starts receiving
 * outlines immediately instead of after the last row is read, and the cost of
 * the endpoint stops scaling with the size of the directory.
 *
 * `?limit=` caps the export for callers that want a sample instead, and
 * `?kind=blog` / `?kind=podcast` exports one category — which is the form a
 * podcast app actually wants, since it has no use for forty thousand blogs.
 */
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const limit = parseLimit(params.get('limit'));
  const kind = q.normalizeKind(params.get('kind'));
  const client = db();

  const title = kind ? `RSS Amplifier — ${kind}s` : 'RSS Amplifier — full directory';
  const filename = kind ? `rssamplifier-${kind}s.opml` : 'rssamplifier.opml';

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(opmlHead(title)));

      try {
        let written = 0;
        for await (const row of q.eachFeedForExport(client, 2000, kind)) {
          if (limit !== null && written >= limit) break;

          controller.enqueue(
            encoder.encode(
              `${opmlOutline({
                title: String(row.title ?? ''),
                feed_url: String(row.feed_url ?? ''),
                site_url: row.site_url ? String(row.site_url) : null,
              })}\n`,
            ),
          );
          written += 1;
        }
      } catch (err) {
        // The head is already on the wire, so the response cannot become an
        // error status. Close out a well-formed document instead of tearing the
        // connection down mid-element and handing readers a parse error — a
        // short list beats an unparseable one.
        console.error('opml export failed partway', err);
      }

      controller.enqueue(encoder.encode(opmlFoot()));
      controller.close();
    },
  });

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
 * @param {string|null} raw
 * @returns {number|null} null when unset or unusable, meaning "no cap"
 */
function parseLimit(raw) {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}
