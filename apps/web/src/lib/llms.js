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
    `Total feeds indexed: ${total} (${byKind.blog} blogs, ${byKind.news} news sources, ${byKind.podcast} podcasts)`,
    '',
    '## Categories',
    '',
    `- [Blogs](${base}/blogs): feeds with no audio attached`,
    `- [News](${base}/news): newsrooms — several articles a day, a staff of bylines, or a masthead that says news, and at least two of those three`,
    `- [Podcasts](${base}/podcasts): feeds carrying audio enclosures or the itunes/podcast namespaces`,
    '',
    'A feed is classified from its own document on every crawl, never by the',
    'submitter, so the category is a fact about the feed rather than a claim.',
    '',
    'News and blogs are the one pair that publish an identical document, so the',
    'split is drawn from how the feed behaves rather than from what it carries,',
    'and it is drawn conservatively: a blog that posts once a week under one name',
    'stays a blog however its masthead reads.',
    '',
    '## Topics',
    '',
    `- [All topics](${base}/topics): what the directory covers, by how many feeds cover it`,
    `- [One topic](${base}/topics/{keyword}): every feed filed under it`,
    `- [One topic, one category](${base}/topics/{keyword}/{group}): just the blogs, or just the podcasts`,
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
    '### A topic, by category',
    '',
    'A well-covered subject is written about by blogs, recorded by podcasts and',
    'filmed by channels at once, so each category the topic has gets an address:',
    '',
    `- \`${base}/topics/{keyword}/blogs\``,
    `- \`${base}/topics/{keyword}/podcasts\``,
    `- \`${base}/topics/{keyword}/audio\` — podcasts and music together`,
    `- \`${base}/topics/{keyword}/music\``,
    `- \`${base}/topics/{keyword}/videos\``,
    `- \`${base}/topics/{keyword}/comics\``,
    `- \`${base}/topics/{keyword}/lives\``,
    `- \`${base}/topics/{keyword}/reels\``,
    '',
    'These are the category page names, so /topics/physics/videos sits under',
    '/videos. A category the topic has nothing in is a 404 rather than an empty',
    'page. Which ones a topic does have, with counts, comes back from',
    '/api/topics/{keyword} — it lists them whether or not you asked for one.',
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
    'The same extensions work on a category of the topic, which is where they',
    `earn their keep: \`${base}/topics/{keyword}/blogs.rss\` is the writing about a`,
    `subject without the video channels in it, and \`${base}/topics/{keyword}/audio.m3u\``,
    'is a playlist of everything on it you can listen to. The playlist formats are',
    "only offered on the categories whose entries are files — an .m3u of a topic's",
    'blogs is an empty playlist.',
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
    '## Command line',
    '',
    `- [Install](${base}/install.sh): \`curl -fsSL ${base}/install.sh | sh\``,
    `- [Documentation](${base}/cli): every command, with examples`,
    `- [The program itself](${base}/cli/rssamp): one Node file, no dependencies`,
    '',
    'For an agent already driving a shell. `rssamp topics <query>` finds subjects,',
    '`rssamp topic <keyword>` lists the feeds on one, and `rssamp urls --topic <keyword>`',
    'prints their feed URLs one per line. Every command takes --json. Prefer the MCP',
    'server above if you can call tools directly — same data, no subprocess.',
    '',
    '## Machine-readable endpoints',
    '',
    `- [All feeds, JSON](${base}/api/feeds): paginated with ?limit= and ?offset=, filter with ?kind=blog|news|podcast|music|video|comic|live|reel`,
    `- [One feed, JSON](${base}/api/feeds/{slug}): metadata plus recent items`,
    `- [Search, JSON](${base}/api/search?q=): full-text over posts and blogs; add &mode=any to match any term rather than all of them`,
    `- [Topics, JSON](${base}/api/topics): shared topics; ?q= searches them, ?min=10 for the well-covered ones`,
    `- [One topic, JSON](${base}/api/topics/{keyword}): the feeds filed under it, plus which categories it has; \`?group=\` narrows it to one`,
    `- [One topic, as a feed](${base}/topics/{keyword}.json): what those feeds published — also .rss, .atom, .m3u, .pls`,
    `- [Authors, JSON](${base}/api/authors): the people behind the feeds and where else they publish; ?network=email|fediverse|bluesky|github|website|linktree, ?q= searches names, ?min= sets the confidence floor`,
    `- [One author, JSON](${base}/api/authors/{slug}): their links and everything they publish here`,
    `- [OPML export](${base}/opml): the whole directory as a subscription list, one category with ?kind=, or one subject with ?topic=`,
    `- [Submit](${base}/api/submit): POST {"url":"..."} or {"urls":[...]} or {"opml":"..."}`,
    `- [Discover](${base}/api/discover): POST {"keywords":["..."]} — find blogs by subject`,
    `- [Discovery status](${base}/api/discoveries/{id}): progress of one keyword run`,
    '',
    '## Notes for agents',
    '',
    '- Every endpoint sends `access-control-allow-origin: *`. No key is required.',
    '- Summaries are plain text, already stripped of markup.',
    '- Each feed has a stable page at /{slug} carrying schema.org Blog or PodcastSeries JSON-LD.',
    '- Each author has a page at /authors/{slug} carrying schema.org Person with sameAs.',
    '- Author links come from what the author published about themselves — rel="me", h-card, JSON-LD sameAs — never from a data broker. Role mailboxes are dropped at extraction, so an email in /api/authors belongs to a person. Each link carries the source it was read from and whether the account links back, so you can decide how much to trust it.',
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
