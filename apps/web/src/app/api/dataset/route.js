import { dataset } from '@rssamplifier/db';

import { latestClosedWindow, windowEnd } from '../../../lib/datasetWindow.js';
import { siteUrl } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * The manifest: what the corpus contains, how it is cut, and how to take it.
 *
 * Open, and answers without a licence. That is the whole reason it is a separate
 * route from the streams it describes.
 *
 * A buyer's first question is "what is actually in there", and the honest way to
 * answer it is a machine-readable description they can read before paying rather
 * than a paragraph of marketing they have to trust. It also means the pipeline
 * that will pull this every four hours can discover the current boundary instead
 * of computing it — so if the cadence ever changes, their code follows without
 * an email.
 *
 * What it deliberately does not contain is a price. There is none in this
 * codebase; licensing is negotiated, and the manifest points at /sales for it.
 *
 * It also does not contain row counts. A `count(*)` over `feed_items` is a
 * multi-second scan of 4.7 million rows against a database whose write path is
 * already saturated, and this is an unauthenticated endpoint — putting one here
 * would be handing anybody a way to make the site slow. The sales page shows the
 * cached directory figures instead, and a licensed caller learns the exact size
 * of a window by taking it.
 */

/**
 * @returns {Response}
 */
export function GET() {
  const newest = latestClosedWindow();
  const base = siteUrl();

  return Response.json(
    {
      corpus: 'rssamplifier.com',
      description:
        'The open small-web directory as a training corpus: independent blogs, podcasts and video feeds, crawled continuously and sliced on a fixed clock.',

      cadence: {
        windowHours: dataset.WINDOW_HOURS,
        // Named rather than implied. A pipeline reading this should walk
        // boundaries in order; saying so here is cheaper than saying it in an
        // email to every buyer.
        semantics:
          'Each window is the half-open range [start, end) on the row timestamp named in `cutOn`. Windows are fixed against the Unix epoch, so a window is the same set of rows whoever asks and whenever they ask. Walk them in order to see every row exactly once.',
        latestClosedWindow: newest,
        latestWindowEnd: windowEnd(newest),
        nextWindowOpensAt: windowEnd(newest),
      },

      datasets: {
        feeds: {
          description:
            'One row per feed in the directory: title, description, canonical feed and site URLs, language, category, item count and crawl state.',
          cutOn: 'created_at — when the directory first saw the feed, so a window is the feeds that are new to it',
          format: 'application/x-ndjson, gzipped',
          url: `${base}/api/dataset/feeds`,
        },
        items: {
          description:
            'One row per post: title, summary, author, canonical URL, publication date, and the feed it belongs to. This is metadata at scale rather than prose — see `bodies` below.',
          cutOn: 'created_at — when the crawler ingested the post',
          format: 'application/x-ndjson, gzipped',
          url: `${base}/api/dataset/items`,
          // Said here, unprompted, because it is the one thing about this corpus
          // a buyer could reasonably assume wrongly and only discover after
          // paying. Posts ingested before the change still carry their body.
          bodies:
            'Posts ingested since 2026-08 do not carry `content_html`: storing a body for every post was 10GB of a 14GB database and the crawler stopped writing it. Full article text lives in the `extracts` dataset, for the subset that has been fetched. Older rows still carry the body they were ingested with.',
        },
        extracts: {
          description:
            'The article itself, sanitized, for posts whose page has been fetched and parsed. Several thousand characters on average. This is the prose in the corpus.',
          cutOn: 'fetched_at — when the article was read, not when it was published, so a window includes an old post that was fetched today',
          format: 'application/x-ndjson, gzipped',
          url: `${base}/api/dataset/extracts`,
          coverage:
            'A fraction of `items`, not a parallel of it: an article is fetched when a reader opens the post, so this grows with attention rather than with the crawl.',
        },
        authors: {
          description:
            'The people behind the feeds, keyed on a URL they control, with their homepages and social profiles folded in as a JSON array.',
          cutOn: 'created_at, filtered rather than seeked — `authors` is small enough to walk whole',
          format: 'application/x-ndjson, gzipped',
          url: `${base}/api/dataset/authors`,
        },
      },

      access: {
        how: 'A licence, granted per buyer. Present a session cookie or an API key as a bearer token; the licence hangs off the account rather than the key, so keys can be rotated freely.',
        enquiries: `${base}/sales`,
        parameters: {
          window:
            'ISO-8601 window boundary. Omit for the newest closed window. An unaligned or still-filling boundary is refused rather than rounded.',
          full: 'full=1 takes the whole history instead of one window. Separately metered, and expensive — intended once, to seed a mirror, before switching to windows.',
        },
        limits:
          'Per-window and per-day allowances are set on the licence and reported in the `x-dataset-*` response headers.',
      },

      provenance: {
        source:
          'Public feeds their publishers chose to syndicate. The directory is open and anyone may submit to it.',
        optOut:
          'A publisher may be excluded from the corpus while staying in the directory, on request to hello@rssamplifier.com. Excluded feeds and every post and article belonging to them are absent from every dataset above.',
        openApi: `Nothing here is a restriction on the open API: ${base}/api/feeds, /api/search, /opml and the MCP server all answer without an account.`,
      },
    },
    { headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' } },
  );
}
