import { social } from '@rssamplifier/db';
import { socialDisplayTitle, socialPathFor } from '@rssamplifier/social';

import { db, siteUrl } from '../lib/db.js';
import ListFilter from './ListFilter.jsx';
import { FILTER_FROM } from '../lib/listFilter.js';

/**
 * The index of one network's sources — `/r` and `/x`.
 *
 * One component over a table of two labels, the way `/blogs` and `/podcasts`
 * share `CategoryIndex`: two copies of a listing drift the moment one grows a
 * feature, and this one is going to grow at least a sort.
 *
 * **It reports two numbers, not one, and that is the honest part.** The
 * subreddit import put 50,099 communities into the directory and the crawler
 * has read a fraction of them, so a page saying "50,099 subreddits" would be
 * promising a directory that mostly does not exist yet. Saying how many have
 * actually been read is the same distinction the MCP server draws with
 * `freshness`, and for the same reason: a row being present is not evidence
 * that anything is behind it.
 */

/** How many sources a page of this listing holds. */
const PER_PAGE = 100;

/**
 * What each namespace calls itself, and the one paragraph it owes a reader.
 *
 * A table rather than a chain of ternaries, which is what this was when there
 * were two platforms and what stopped scaling at three.
 */
const LOOKS = {
  reddit: {
    platform: 'Reddit',
    noun: 'communities and users',
    base: '/r',
    placeholder: 'r/programming',
    addLabel: 'Add a subreddit or Reddit user',
    blurb:
      'Reddit publishes a feed for every community. We read them on a schedule and keep a copy, so these addresses work whether or not Reddit is answering right now.',
  },
  x: {
    platform: 'X',
    noun: 'accounts, searches and lists',
    base: '/x',
    placeholder: '@OpenAI',
    addLabel: 'Add an X account, list or search',
    blurb:
      'X publishes no feeds, so these are collected on your behalf and mirrored here — the posts you read come out of this directory, never out of X.',
  },
  instagram: {
    platform: 'Instagram',
    noun: 'accounts and hashtags',
    base: '/ig',
    placeholder: 'ig/nasa',
    addLabel: 'Add an Instagram account or hashtag',
    blurb:
      'Instagram publishes no feeds either, so these are collected and mirrored the same way X is. Private accounts are not collected, and neither are stories — they expire, and a feed of things that have already gone is worse than no feed.',
  },
  facebook: {
    platform: 'Facebook',
    noun: 'connected Pages',
    base: '/fb',
    placeholder: '',
    addLabel: '',
    blurb:
      'Facebook is the one platform here that cannot be added by whoever wants it. There is no public feed, no page without a login, and no bridge — only Meta’s Graph API, which returns a Page’s posts to somebody who administers that Page. So these are Pages whose operators connected them, and nothing else can be.',
  },
};

/**
 * @param {{ network: 'x'|'reddit', page?: number }} props
 */
export default async function SocialIndex({ network, page = 1 }) {
  const client = db();
  const offset = (Math.max(1, page) - 1) * PER_PAGE;

  const [rows, counts] = await Promise.all([
    social.listSocialFeeds(client, network, { limit: PER_PAGE, offset }),
    social.countSocialFeeds(client, network),
  ]);

  const { platform, noun, base, blurb, placeholder, addLabel } = LOOKS[network];

  return (
    <main className="prose">
      <h1>{platform}</h1>

      <p>
        {counts.total.toLocaleString()} {platform} {noun} in the directory,{' '}
        {counts.crawled.toLocaleString()} of which we have read at least once. Every one has a
        page here and a feed in four formats, at an address that does not change.
      </p>

      <p>{blurb}</p>

      {/* Facebook has no add form, and that is not an oversight: a Page can
          only be connected by somebody who administers it, so a box inviting
          anyone to paste a Page would be a box that quietly does nothing. */}
      {network === 'facebook' ? null : (
        <form method="post" action="/api/submit" className="add-source">
          <label htmlFor="social-input">{addLabel}</label>
          <input id="social-input" name="input" type="text" placeholder={placeholder} required />
          <button type="submit">Add</button>
        </form>
      )}

      {rows.length >= FILTER_FROM ? (
        <ListFilter
          target=".feed-list li"
          noun={`${platform} source`}
          label={`Filter these ${platform} sources`}
          // The escape hatch for a name that is not on this page — the
          // directory has far more of these than one page can hold.
          searchHref="/search?q="
          searchLabel="Search the whole directory"
        />
      ) : null}

      {rows.length === 0 ? (
        <p>Nothing here yet. Add the first one above.</p>
      ) : (
        <ul className="feed-list">
          {rows.map((row) => {
            const href = socialPathFor(row);
            // The canonical name where the imported title says nothing — most
            // of the catalogue is uncrawled and titled with the bare host.
            const name = socialDisplayTitle(row, href.replace(/^\//, ''));
            return (
              <li key={String(row.slug)}>
                <a className="feed-row" href={href}>
                  <strong>{name}</strong>
                  {row.description ? <span> — {String(row.description)}</span> : null}
                </a>{' '}
                <a href={`${href}.rss`} title="RSS">
                  rss
                </a>
              </li>
            );
          })}
        </ul>
      )}

      {rows.length === PER_PAGE ? (
        <p>
          <a href={`${base}?page=${page + 1}`}>Next page</a>
        </p>
      ) : null}

      <p>
        Everything here also feeds the topic pages, mixed in with blogs, podcasts and the rest —
        see <a href="/topics">topics</a>. The directory&rsquo;s own river is at{' '}
        <code>{siteUrl()}/feed.rss</code>.
      </p>
    </main>
  );
}

/**
 * `?page=` as a number, defaulting to the first.
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function pageNumber(raw) {
  const parsed = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
}
