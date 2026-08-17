import { q } from '@rssamplifier/db';
import { SYNDICATION_FORMATS, buildSyndication, topicSlug } from '@rssamplifier/feed';

import { db, siteUrl } from '../../../../../../lib/db.js';

export const dynamic = 'force-dynamic';

/** How many items a topic feed carries by default, and at most. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * One topic, as something a reader can subscribe to.
 *
 * The addressable form of this is the extension on the topic page itself —
 * `/topics/physics.rss`, `.atom`, `.json`, `.m3u`, `.pls` — which is a rewrite
 * onto this handler (see next.config.mjs). Both spellings answer, and the
 * document names the pretty one as its `rel="self"` so a reader that arrived by
 * the API path still records the canonical address.
 *
 * What comes back is a **river**: recent posts from the feeds filed under the
 * topic, not a listing of those feeds. The listing already exists in two forms
 * — the topic page, and `/api/topics/:slug` as JSON — and the two answer
 * different questions. A reader subscribing to `/topics/physics.rss` wants to
 * be told when somebody writes about physics, not to be handed a directory.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ keyword: string, format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { keyword, format: rawFormat } = await params;
  const format = String(rawFormat ?? '').toLowerCase();
  const spec = SYNDICATION_FORMATS.get(format);

  if (!spec) {
    return fail(
      'json',
      404,
      `unsupported format: ${format}`,
      `Supported: ${[...SYNDICATION_FORMATS.keys()].join(', ')}`,
    );
  }

  // Normalised the same way the page and the JSON endpoint normalise it, so
  // "Home Lab", "home-lab" and "home lab" are all one feed rather than three
  // addresses for it.
  const slug = topicSlug(decodeURIComponent(String(keyword ?? '')));

  const url = new URL(req.url);
  const limit = Math.min(
    Math.max(Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  const client = db();
  const topic = await q.topicBySlug(client, slug);

  if (!topic) {
    return fail(format, 404, `no such topic: ${slug}`, `Browse ${siteUrl()}/topics`);
  }

  // A playlist can only carry files, so it is drawn from a different query than
  // a feed is — see mediaForTopic for why that is not just a filter.
  const rows = spec.media
    ? await q.mediaForTopic(client, slug, { limit })
    : await q.itemsForTopic(client, slug, { limit });

  const page = `${siteUrl()}/topics/${encodeURIComponent(topic.slug)}`;

  const channel = {
    title: `${topic.keyword} — RSS Amplifier`,
    description: spec.media
      ? `Playable media from the ${topic.feedCount} feeds in the RSS Amplifier directory that cover ${topic.keyword}.`
      : `Recent posts from the ${topic.feedCount} feeds in the RSS Amplifier directory that cover ${topic.keyword}.`,
    link: page,
    selfUrl: `${page}.${format}`,
  };

  const body = buildSyndication(
    format,
    channel,
    rows.map((row) => ({
      ...row,
      // The publisher's guid is the item's identity everywhere else in this
      // codebase, and it is what keeps a reader from showing the same post
      // twice after a re-crawl renumbers our own row ids.
      id: String(row.guid ?? row.url ?? ''),
    })),
  );

  return new Response(body, {
    headers: {
      'content-type': spec.type,
      'content-disposition': `inline; filename="${filename(topic.slug, format)}"`,
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  });
}

/**
 * A filename a reader or a player will not be embarrassed by.
 *
 * Matters most for the playlists: a browser handed an `.m3u` saves it to disk,
 * and "download" is a worse name for it than "rssamplifier-jazz.m3u".
 *
 * @param {string} slug
 * @param {string} format
 * @returns {string}
 */
function filename(slug, format) {
  return `rssamplifier-${slug.replace(/[^a-z0-9-]+/gi, '-')}.${format}`;
}

/**
 * An error a caller can read in whichever shape they asked for.
 *
 * A feed reader handed a JSON error where it expected XML reports a parse
 * failure rather than a missing topic, which sends whoever is debugging it to
 * entirely the wrong place — so the response type follows the request.
 *
 * @param {string} format
 * @param {number} status
 * @param {string} error
 * @param {string} hint
 * @returns {Response}
 */
function fail(format, status, error, hint) {
  const json = format === 'json';
  const body = json ? `${JSON.stringify({ error, hint }, null, 2)}\n` : `${error}\n${hint}\n`;

  return new Response(body, {
    status,
    headers: {
      'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}
