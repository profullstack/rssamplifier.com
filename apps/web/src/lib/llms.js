import { q } from '@rssamplifier/db';

import { db, siteUrl } from './db.js';

/**
 * llms.txt — the directory, described for language models.
 *
 * A plain-text index an agent can read in one request instead of crawling every
 * page. This is the product thesis in a single file: most of the web is closing
 * to AI crawlers, and this directory is deliberately open.
 *
 * Lives in lib rather than in the route because the MCP server serves the same
 * document as a resource. Two copies of this text would drift, and the copy
 * that drifted would be the one describing the endpoints to agents.
 *
 * @param {{ feedLimit?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function llmsTxt(opts = {}) {
  const { feedLimit = 500 } = opts;
  const client = db();
  const base = siteUrl();

  const [feeds, total, byKind] = await Promise.all([
    q.allFeedsForExport(client, feedLimit),
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
    '## Topics',
    '',
    `- [All topics](${base}/topics): what the directory covers, by how many feeds cover it`,
    `- [One topic](${base}/topics/{keyword}): every feed filed under it`,
    '',
    "The index lists topics at least two feeds share. A feed's own topics —",
    'including the ones nobody else has — are on its page and in its JSON.',
    '',
    'Topics come from two places: the <category> tags a publisher wrote, and the',
    "one-, two- and three-word phrases that recur across a feed's titles and",
    'summaries. Each feed carries which of the two a topic came from, so a tag',
    'the author chose can be told apart from a phrase we counted.',
    '',
    'The keyword in the URL is normalised, so "Home Lab", "home lab" and',
    '"home-lab" all reach the same page.',
    '',
    '### A topic as a feed',
    '',
    'Add an extension to a topic URL and you get what its feeds have published,',
    'rather than a list of the feeds themselves:',
    '',
    `- \`${base}/topics/{keyword}.rss\` — RSS 2.0, with enclosures (\`.xml\` is the same document)`,
    `- \`${base}/topics/{keyword}.atom\` — Atom 1.0`,
    `- \`${base}/topics/{keyword}.json\` — JSON Feed 1.1`,
    `- \`${base}/topics/{keyword}.m3u\` — M3U playlist of the playable media only`,
    `- \`${base}/topics/{keyword}.pls\` — the same, as PLS`,
    '',
    'Fifty items by default, up to 200 with ?limit=. Note the difference from',
    '/api/topics/{keyword}, which lists *who* covers the topic: these list *what*',
    'they published. Drawn from the 200 feeds most strongly filed under the',
    'topic, so a very broad keyword is a sample rather than a census.',
    '',
    '## MCP server',
    '',
    `- [MCP endpoint](${base}/mcp): Streamable HTTP, no key, no sign-up`,
    '',
    'The same capabilities as the endpoints below, as tools an agent can call:',
    'search, list_feeds, get_feed, list_topics, get_topic, topic_posts, read_post,',
    'random_feed, directory_stats and submit_feed. Point an MCP client at',
    `\`${base}/mcp\` — it answers both the current protocol revision and the`,
    'older handshake-based ones. Documentation for humans is at the same URL in a',
    `browser: ${base}/mcp`,
    '',
    '## Machine-readable endpoints',
    '',
    `- [All feeds, JSON](${base}/api/feeds): paginated with ?limit= and ?offset=, filter with ?kind=blog|podcast`,
    `- [One feed, JSON](${base}/api/feeds/{slug}): metadata plus recent items`,
    `- [Search, JSON](${base}/api/search?q=): full-text over posts and blogs; add &mode=any to match any term rather than all of them`,
    `- [Topics, JSON](${base}/api/topics): shared topics; ?min=10 for the well-covered ones`,
    `- [One topic, JSON](${base}/api/topics/{keyword}): the feeds filed under it`,
    `- [One topic, as a feed](${base}/topics/{keyword}.json): what those feeds published — also .rss, .atom, .m3u, .pls`,
    `- [OPML export](${base}/opml): the whole directory as a subscription list, or one category with ?kind=`,
    `- [Submit](${base}/api/submit): POST {"url":"..."} or {"urls":[...]} or {"opml":"..."}`,
    `- [Discover](${base}/api/discover): POST {"keywords":["..."]} — find blogs by subject`,
    `- [Discovery status](${base}/api/discoveries/{id}): progress of one keyword run`,
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
    // Only the non-blog categories are marked. Blogs are the overwhelming
    // majority, so labelling those too would add a word to nearly every line of
    // the file to convey the default.
    const kind = f.category && f.category !== 'blog' ? ` (${f.category})` : '';
    lines.push(`- [${f.title}](${base}/${f.slug})${kind}${desc}`);
  }

  return `${lines.join('\n')}\n`;
}
