import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * llms.txt — the directory, described for language models.
 *
 * A plain-text index an agent can read in one request instead of crawling every
 * page. This is the product thesis in a single file: most of the web is closing
 * to AI crawlers, and this directory is deliberately open.
 */
export async function GET() {
  const client = db();
  const base = siteUrl();

  const [feeds, total, byKind] = await Promise.all([
    q.allFeedsForExport(client, 500),
    q.countFeeds(client),
    q.countFeedsByKind(client),
  ]);

  const lines = [
    '# RSS Amplifier',
    '',
    '> An open directory of independent blogs and their RSS feeds. Anyone may submit a',
    '> feed; there are no accounts and no paywall. Crawling and reuse are welcome.',
    '',
    `Total feeds indexed: ${total} (${byKind.blog} blogs, ${byKind.podcast} podcasts)`,
    '',
    '## Categories',
    '',
    `- [Blogs](${base}/blogs): feeds with no audio attached`,
    `- [Podcasts](${base}/podcasts): feeds carrying audio enclosures or the itunes/podcast namespaces`,
    '',
    'A feed is classified from its own document on every crawl, never by the',
    'submitter, so the category is a fact about the feed rather than a claim.',
    '',
    '## Machine-readable endpoints',
    '',
    `- [All feeds, JSON](${base}/api/feeds): paginated with ?limit= and ?offset=, filter with ?kind=blog|podcast`,
    `- [One feed, JSON](${base}/api/feeds/{slug}): metadata plus recent items`,
    `- [Search, JSON](${base}/api/search?q=): full-text over posts and blogs`,
    `- [OPML export](${base}/opml): the whole directory as a subscription list, or one category with ?kind=`,
    `- [Submit](${base}/api/submit): POST {"url":"..."} or {"urls":[...]} or {"opml":"..."}`,
    '',
    '## Notes for agents',
    '',
    '- Every endpoint sends `access-control-allow-origin: *`. No key is required.',
    '- Summaries are plain text, already stripped of markup.',
    '- Each feed has a stable page at /{slug} carrying schema.org Blog or PodcastSeries JSON-LD.',
    '- Please identify yourself in your user-agent. Rate limits are generous but real.',
    '',
    '## Feeds',
    '',
  ];

  for (const f of feeds) {
    const desc = f.description ? `: ${String(f.description).slice(0, 160)}` : '';
    // Only podcasts are marked. Blogs are the overwhelming majority, so
    // labelling those too would add a word to nearly every line of the file to
    // convey the default.
    const kind = f.kind === 'podcast' ? ' (podcast)' : '';
    lines.push(`- [${f.title}](${base}/${f.slug})${kind}${desc}`);
  }

  return new Response(`${lines.join('\n')}\n`, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=600',
    },
  });
}
