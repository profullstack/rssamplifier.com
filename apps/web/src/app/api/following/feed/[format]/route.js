import { accounts } from '@rssamplifier/db';
import {
  SYNDICATION_FORMATS,
  adSlotsFor,
  buildSyndication,
  interleaveAds,
} from '@rssamplifier/feed';

import { db, siteUrl } from '../../../../../lib/db.js';
import { fetchFeedAds } from '../../../../../lib/feedAds.js';
import { RIVER_LIMIT, following, followingFeedUrl } from '../../../../../lib/following.js';

export const dynamic = 'force-dynamic';

/**
 * One reader's river, as a feed their reader app can poll.
 *
 * Addressed as `/following.rss?t=<token>` — a rewrite onto this handler, the
 * same trick the topic feeds use (see next.config.mjs). The token is a query
 * parameter rather than a path segment because a rewrite's *destination* query
 * never reaches an App Router handler, while the caller's own query does.
 *
 * The token is the whole of the authentication, and deliberately so: a feed
 * reader has no session cookie and no way to sign in. What it buys is read of
 * posts that are already public, selected by follows this account made — see
 * migration 0022 for why that is stored the way it is.
 *
 * Only the three document formats. The playlist formats are absent because they
 * would be a promise this river cannot keep: it is drawn from whatever the
 * reader follows, most of which has no enclosure, so an `.m3u` would frequently
 * be an empty file. A followed topic's own `.m3u` still exists on the topic.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { format: raw } = await params;
  const format = String(raw ?? '').toLowerCase();
  const spec = SYNDICATION_FORMATS.get(format);

  if (!spec || spec.media) {
    return fail(format, 404, `unsupported format: ${format}`, 'Supported: rss, atom, json, xml');
  }

  const token = new URL(req.url).searchParams.get('t') ?? '';
  const client = db();
  const user = await accounts.userByFeedToken(client, token);

  // One answer for a missing token, a mistyped one and a rotated one. Telling
  // them apart would confirm a guess, and none of the three has anything to
  // read here.
  if (!user) {
    return fail(
      format,
      401,
      'this feed needs your own token',
      `Create or rotate one at ${siteUrl()}/following`,
    );
  }

  const { feeds, topics, authors, items } = await following(client, String(user.id), {
    limit: RIVER_LIMIT,
  });

  const origin = siteUrl();

  const rows = items.map((row) => ({
    ...row,
    // The publisher's guid, the same identity every other feed on the site
    // uses, so a re-crawl that renumbers our rows does not make a reader show
    // the same post twice.
    id: String(row.guid ?? row.url ?? ''),
  }));

  // Sponsored items at the same one-in-ten rate as the topic feeds. The ad is
  // not personalised and carries nothing about this account: the request to the
  // ad network names the slot and nothing else, and the surface tag is what
  // distinguishes this river from a topic's in the advertiser's own analytics.
  // That matters here in a way it does not elsewhere — this is the one feed on
  // the site that belongs to a particular person.
  const wanted = adSlotsFor(rows.length);
  const ads = wanted > 0 ? await fetchFeedAds(wanted, { src: 'following' }) : [];

  const body = buildSyndication(
    format,
    {
      title: 'Following — RSS Amplifier',
      description: `Recent posts from the ${count(topics.length, 'topic')}, ${count(
        authors.length,
        'person',
        'people',
      )} and ${count(feeds.length, 'blog')} this RSS Amplifier account follows.`,
      link: `${origin}/following`,
      selfUrl: followingFeedUrl(origin, token, format),
    },
    interleaveAds(rows, ads),
  );

  return new Response(body, {
    headers: {
      'content-type': spec.type,
      'content-disposition': 'inline; filename="rssamplifier-following.' + format + '"',
      // Private, and no CORS header: unlike every other feed here this document
      // is one account's, so it must not be cached by anything shared and must
      // not be readable by a page on another origin.
      'cache-control': 'private, max-age=300',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

/**
 * "3 topics", "1 blog" — the channel description is a sentence somebody reads in
 * their reader, and "1 blogs" in it makes the whole feed look unattended.
 *
 * @param {number} n
 * @param {string} noun
 * @returns {string}
 */
function count(n, noun, plural = `${noun}s`) {
  return `${n} ${n === 1 ? noun : plural}`;
}

/**
 * An error in the shape the caller asked for — an XML reader handed JSON reports
 * a parse failure rather than the problem it actually has.
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
      'cache-control': 'no-store',
    },
  });
}
