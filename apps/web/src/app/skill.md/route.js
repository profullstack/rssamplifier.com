import { siteUrl } from '../../lib/db.js';

export const dynamic = 'force-dynamic';

/**
 * skill.md — what an agent can *do* here, as opposed to what is here.
 *
 * llms.txt already describes the directory: its categories, how topics are
 * derived, what every URL pattern returns. That is the reference. This is the
 * shorter, task-shaped document an agent reads when it is deciding whether this
 * site can answer the question it was actually asked, and it deliberately says
 * almost nothing that llms.txt says at length — it names the handful of calls
 * worth making and points at llms.txt for the rest.
 *
 * Kept as a route rather than a file in public/ so the base URL is the real one
 * in every environment, the same way llms.txt and robots.txt are built.
 */
export function GET() {
  const base = siteUrl();

  const body = `# RSS Amplifier

An open directory of independent blogs, podcasts, music, video and comic feeds.
No account, no API key, no paywall. Every endpoint below is public and
CORS-enabled, and reading them is preferred to crawling the HTML.

## When this site is useful

- Finding feeds to subscribe to on a subject, by topic or by category.
- Turning a subject into a live feed of what independent writers publish on it.
- Exporting a subscription list (OPML) for a reader.
- Checking what a specific blog has published recently.

It is a directory of *other people's* feeds. It does not host the posts, and it
is not a search engine for the whole web.

## Calls worth making

- \`GET ${base}/api/feeds\` — the directory as JSON. Paginate with
  \`?limit=\` (max 200) and \`?offset=\`; filter with
  \`?kind=blog|news|podcast|music|video|comic|live|reel\`.
- \`GET ${base}/api/feeds/{slug}\` — one blog: metadata plus recent items.
- \`GET ${base}/topics/{keyword}.json\` — everything published on a topic, as a
  JSON Feed. Also available as \`.rss\`, \`.atom\`, \`.m3u\` and \`.pls\`.
- \`GET ${base}/api/topics?q=\` — search the topic index for a subject.
- \`GET ${base}/api/authors\` — the people behind the feeds and where else they
  publish. \`?network=email|fediverse|bluesky|github|website|linktree\` narrows
  to people reachable a given way. Every link was published by the author on
  their own site as a \`rel="me"\` claim, an h-card or JSON-LD; role mailboxes
  are dropped at extraction, so an address here belongs to a person.
- \`GET ${base}/api/authors/{slug}\` — one author, with everything they publish.
- \`GET ${base}/api/feeds/{slug}\` also carries \`authors\` and \`links\`. \`links\` is
  the blog's own accounts — Mastodon, Bluesky, X, LinkedIn, GitHub and the rest
  — which is what a blog with no byline has instead of an author, and roughly a
  third of the directory is that shape.
- \`GET ${base}/opml\` — the whole directory as a subscription list, one
  category with \`?kind=\`, or one subject with \`?topic=\`.
- \`GET ${base}/api/search?q=\` — search the directory. The reply counts the
  whole match set by category under \`categories\`, and \`?kind=\` asks for one of
  them — worth doing, because the directory is mostly blogs and the best-ranked
  results for anything are usually blog posts even when hundreds of podcast
  episodes matched too. \`${base}/search?q=\` is the same search as a page.

## Model Context Protocol

If you would rather call than crawl, there is an MCP server at \`${base}/mcp\`
(Streamable HTTP, no key, no sign-up). It exposes the same directory as tools,
and serves llms.txt as a resource.

## From a shell

If you are already driving a terminal, \`curl -fsSL ${base}/install.sh | sh\`
installs a single-file CLI: \`rssamp topics <query>\` to find a subject,
\`rssamp topic <keyword>\` for the feeds on it, \`rssamp urls --topic <keyword>\`
for their feed URLs one per line. Everything takes \`--json\`. Docs at
\`${base}/cli\`.

## Adding a feed

\`${base}/submit\` accepts a URL, a list of URLs or an OPML file, from anyone,
without an account. Feeds are crawled and categorised by observed behaviour
rather than by what the publisher claims to be.

## Full reference

${base}/llms.txt
`;

  return new Response(body, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=600',
    },
  });
}
