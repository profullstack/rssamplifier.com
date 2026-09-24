import { social } from '@rssamplifier/db';
import { socialDisplayTitle, socialPathFor } from '@rssamplifier/social';

import { db, siteUrl } from '../lib/db.js';
import ListFilter from './ListFilter.jsx';
import { FILTER_FROM } from '../lib/listFilter.js';
import { Avatar } from './Thumb.jsx';
import { feedImage } from '../lib/thumbs.js';

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
    noun: 'Pages',
    base: '/fb',
    placeholder: 'fb/SomePage',
    addLabel: 'Add a Facebook Page',
    blurb:
      'Facebook publishes no feeds and shows nothing without a login, so these are read on your behalf and mirrored here. Expect them to be the least dependable part of this directory: Facebook changes its markup without warning and works harder than the others to stop anyone reading it this way, so a Page here goes quiet from time to time. Pages only — a personal profile cannot be read at all.',
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
  const lastPage = Math.max(1, Math.ceil(counts.total / PER_PAGE));

  // A fragment, not a `<main>`: the layout already wraps every page in
  // `main.wrap`, which is what carries the measure and the gutters. A second
  // `<main>` inside it was both a duplicate landmark and — dressed in a `.prose`
  // class that matches no rule in the stylesheet — styled by nothing at all.
  return (
    <>
      <h1>{platform}</h1>

      <p>
        {counts.total.toLocaleString()} {platform} {noun} in the directory,{' '}
        {counts.crawled.toLocaleString()} of which we have read at least once. Every one has a
        page here and a feed in four formats, at an address that does not change.
      </p>

      <p>{blurb}</p>

      <form method="post" action="/api/submit" className="add-source">
        <label htmlFor="social-input">{addLabel}</label>
        <input id="social-input" name="input" type="text" placeholder={placeholder} required />
        <button type="submit">Add</button>
      </form>

      {rows.length >= FILTER_FROM ? (
        <ListFilter
          target=".feed-list .feed-row"
          noun={`${platform} source`}
          label={`Filter these ${platform} sources`}
          // The escape hatch for a name that is not on this page — the
          // directory has far more of these than one page can hold.
          searchHref="/search?q="
          searchLabel="Search the whole directory"
        />
      ) : null}

      {rows.length === 0 ? (
        <p className="empty">Nothing here yet. Add the first one above.</p>
      ) : (
        /*
         * A `<div>` of rows rather than a `<ul>` of `<li>`, which is what
         * `CategoryIndex` and every other listing on the site does — and the
         * reason this page looked wrong. `.feed-list` is a grid whose 1px gaps
         * show its own background through as hairline dividers, so it wants the
         * cards themselves as its children. Wrapping each in an `<li>` put an
         * unstyled element in every cell, leaving the divider colour showing
         * behind the row, and the stylesheet has no list reset, so the browser's
         * own `padding-inline-start` indented the whole set inside its border
         * and hung bullets in the gutter.
         */
        <div className="feed-list">
          {rows.map((row) => {
            const href = socialPathFor(row);
            // The canonical name where the imported title says nothing — most
            // of the catalogue is uncrawled and titled with the bare host.
            const name = socialDisplayTitle(row, href.replace(/^\//, ''));
            const site = row.site_url ? hostOf(String(row.site_url)) : null;
            const items = Number(row.item_count ?? 0);

            return (
              /*
               * The row's own parts, in the shape `.feed-row`'s grid is cut for:
               * the avatar in the first column, then heading, description and
               * meta line in the second. The old markup used a bare `<strong>`
               * and `<span>`, which the grid placed on separate rows of their
               * own and which picked up none of the `.feed-row h3` / `p` type —
               * so a name and a 500-word subreddit sidebar arrived unstyled,
               * unclamped and stacked.
               */
              <div className="feed-row" key={String(row.slug)}>
                <Avatar src={feedImage(row)} title={name} slug={row.slug} />
                <h3>
                  <a className="row-link" href={href}>
                    {name}
                  </a>
                </h3>
                {row.description ? <p>{String(row.description)}</p> : null}
                <div className="feed-meta">
                  {site ? <span>{site}</span> : null}
                  <span>
                    {items.toLocaleString()} {items === 1 ? 'post' : 'posts'}
                  </span>
                  {/* Kept, but moved inside the meta line: it used to sit
                      outside the row's anchor entirely, which dropped it onto
                      the divider strip below the card as loose text. */}
                  <a className="row-aside" href={`${href}.rss`} title={`${name} — RSS`}>
                    rss
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* The house pager, both ends labelled, rather than a lone "Next page"
          link that never said where you were or offered a way back. */}
      {lastPage > 1 ? (
        <nav className="pager" aria-label={`${platform} pages`}>
          {page > 1 ? (
            <a href={page === 2 ? base : `${base}?page=${page - 1}`} rel="prev">
              ← Previous
            </a>
          ) : (
            <span className="disabled">← Previous</span>
          )}
          <span className="pill">
            Page {page.toLocaleString()} of {lastPage.toLocaleString()}
          </span>
          {page < lastPage ? (
            <a href={`${base}?page=${page + 1}`} rel="next">
              Next →
            </a>
          ) : (
            <span className="disabled">Next →</span>
          )}
        </nav>
      ) : null}

      <p>
        Everything here also feeds the topic pages, mixed in with blogs, podcasts and the rest —
        see <a href="/topics">topics</a>. The directory&rsquo;s own river is at{' '}
        <code>{siteUrl()}/feed.rss</code>.
      </p>
    </>
  );
}

/**
 * The bare host of a URL, for the meta line.
 *
 * Falls back to the string it was given: a listing has no reason to refuse to
 * render over one malformed `site_url` in a directory this size.
 *
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
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
