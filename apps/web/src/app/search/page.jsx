import { q } from '@rssamplifier/db';

import { db } from '../../lib/db.js';
import { feedAlternates } from '../../lib/subscribe.js';
import { AD_MREC, AD_TEXT, adPlan } from '../../lib/ads.js';
import { CATEGORIES } from '../../lib/categories.js';
import { filtersWithHits, searchFilter, searchHref, totalHits } from '../../lib/searchFilters.js';
import Ad from '../Ad.jsx';
import AdBanner from '../AdBanner.jsx';
import SubscribeLinks from '../SubscribeLinks.jsx';
import Thumb, { Avatar } from '../Thumb.jsx';
import Toolbar from '../Toolbar.jsx';
import { feedImage, postThumb } from '../../lib/thumbs.js';

export const dynamic = 'force-dynamic';

/**
 * A search that found something is also a subscription: `/search.rss?q=lisp`
 * tells a reader when three hundred thousand feeds mention it, with no account
 * anywhere. That is only announceable once the query is known, which is why
 * this is a function rather than the static block it used to be.
 *
 * @param {{ searchParams: Promise<{ q?: string, kind?: string }> }} props
 */
export async function generateMetadata({ searchParams }) {
  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const filter = searchFilter(params.kind);
  const suffix = `?q=${encodeURIComponent(query)}${filter ? `&kind=${filter.segment}` : ''}`;

  return {
    title: query ? `${query} · Search` : 'Search',
    description: 'Full-text search across every blog, podcast, channel and post in the directory.',
    ...(query
      ? { alternates: { types: feedAlternates('/search', `${query} — RSS Amplifier`, suffix) } }
      : {}),
  };
}

/**
 * What one result is, for the label on its row.
 *
 * The entry noun rather than the feed noun — a result is an episode, not a
 * podcast. Blogs are left unlabelled on purpose: they are nine rows in ten, so
 * labelling them says nothing, and labelling only the others is what makes an
 * episode stand out in a column of writing.
 *
 * @param {unknown} category
 * @returns {string|null}
 */
function kindLabel(category) {
  const kind = String(category ?? '');
  if (!kind || kind === 'blog') return null;
  return CATEGORIES[kind]?.entry ?? null;
}

/**
 * @param {{ searchParams: Promise<{ q?: string, kind?: string }> }} props
 */
export default async function SearchPage({ searchParams }) {
  const params = await searchParams;
  const query = (params.q ?? '').trim();

  // Which slice of the results is being asked for. An unknown kind reads as no
  // filter at all, so a mistyped URL still searches.
  const filter = searchFilter(params.kind);

  let blogs = [];
  let posts = [];
  let counts = { posts: {}, feeds: {} };

  if (query) {
    const client = db();
    [blogs, posts, counts] = await Promise.all([
      q.searchFeeds(client, query, 20, 'all', filter?.kinds ?? null),
      q.searchItems(client, query, 40, 'all', filter?.kinds ?? null),
      // Counted over the whole match set rather than over the rows below, which
      // is the entire point of the row of filters: it can only say there are
      // 1,521 matching podcast episodes if it looked past the forty blog posts
      // that outranked them.
      q.searchKindCounts(client, query),
    ]);
  }

  const kagi = `https://kagi.com/search?q=${encodeURIComponent(query)}`;

  // Somebody who has typed a query has told us what they want, which makes this
  // the most valuable page on the site — and the easiest one to ruin. So: a
  // blank /search carries no advertising at all (there is nothing to be
  // relevant to), a search that found nothing carries exactly one line, and a
  // search that found something carries the full set.
  const found = blogs.length > 0 || posts.length > 0;

  // The query string the feed links carry, so `/search.rss?q=…` asks the same
  // question the page just answered — filter included.
  const searchQuery = `?q=${encodeURIComponent(query)}${filter ? `&kind=${filter.segment}` : ''}`;
  const postAds = adPlan(posts.length, { first: 8, every: 20, max: 2, formats: [AD_TEXT] });

  const filters = query ? filtersWithHits(counts) : [];
  const total = totalHits(counts);

  // The two section headings follow the filter: under Podcasts, a list of shows
  // is not "Blogs" and a list of episodes is not "Posts".
  const feedsHeading = filter ? filter.heading : 'Blogs';
  const postsHeading = filter ? filter.item[0].toUpperCase() + filter.item.slice(1) : 'Posts';

  return (
    <>
      <h1>Search</h1>
      <p className="lede">
        Across every post we have collected — writing, episodes, tracks and video alike.
      </p>

      <form className="submit-box" method="get" action="/search">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="agentic coding, rss, self-hosting…"
          aria-label="Search query"
        />
        {/* The filter rides along with the next query rather than being reset by
            it: somebody narrowed to podcasts and then searched again is still
            looking for podcasts. The row below is how they get back out. */}
        {filter && <input type="hidden" name="kind" value={filter.segment} />}
        <div className="submit-actions">
          <button type="submit">Search</button>
        </div>
      </form>

      {/* What matched, by category. This is the answer to "why is this all
          blogs?" — it is not, and each of these says how much of it is not.
          Only filters with something behind them are offered, and the row is
          skipped entirely when everything landed in one category, where it
          would be a single link back to the page you are on. */}
      {filters.length > 1 && (
        <nav className="result-groups" aria-label="Results by category">
          <a
            href={searchHref(query)}
            aria-current={filter ? undefined : 'page'}
            className={filter ? undefined : 'is-current'}
          >
            All <span>{total.toLocaleString('en-US')}</span>
          </a>
          {filters.map(({ group, count }) => (
            <a
              key={group.segment}
              href={searchHref(query, group.segment)}
              aria-current={group.segment === filter?.segment ? 'page' : undefined}
              className={group.segment === filter?.segment ? 'is-current' : undefined}
            >
              {group.heading} <span>{count.toLocaleString('en-US')}</span>
            </a>
          ))}
        </nav>
      )}

      {/*
       * Directly under the box, above the results: the sponsored-result
       * position, and the strongest one on any search page. It stays a text
       * link so it reads as an offer rather than as the first result.
       */}
      {query && <Ad format={AD_TEXT} />}

      {/* A standing question, as a feed. Offered only when the search found
          something: subscribing to a query that matches nothing today is a
          reasonable thing to want, but a link that hands back an empty document
          looks broken rather than patient. */}
      {found && <SubscribeLinks base="/search" query={searchQuery} what={`“${query}”`} label="Subscribe to this search:" />}

      {query && blogs.length === 0 && posts.length === 0 && (
        <p className="empty">
          {filter ? (
            <>
              Nothing under {filter.heading.toLowerCase()} for &ldquo;{query}&rdquo;.{' '}
              <a href={searchHref(query)}>Search everything</a>, or try{' '}
              <a href={kagi} rel="noopener">
                Kagi
              </a>
              .
            </>
          ) : (
            <>
              Nothing for &ldquo;{query}&rdquo;. Try{' '}
              <a href={kagi} rel="noopener">
                Kagi
              </a>{' '}
              instead.
            </>
          )}
        </p>
      )}

      {blogs.length > 0 && (
        <>
          <h2>{feedsHeading}</h2>
          <div className="feed-list">
            {blogs.map((b) => (
              <a className="feed-row" key={String(b.slug)} href={`/${b.slug}`}>
                <Avatar src={feedImage(b)} title={b.title} slug={b.slug} />
                <h3>{b.title}</h3>
                {b.description && <p>{b.description}</p>}
              </a>
            ))}
          </div>
        </>
      )}

      {/* Between the two result sets — a natural break, so a box fits here. */}
      {blogs.length > 0 && posts.length > 0 && <Ad format={AD_MREC} />}

      {posts.length > 0 && (
        <>
          <h2>{postsHeading}</h2>
          {posts.flatMap((p, i) => {
            // A result goes to our reader, not straight off the site: the post
            // is framed with the toolbar still on screen, and the way out to
            // the original lives down there rather than being the only option.
            // Needs a guid to address; without one there is nothing to link to.
            const href = p.guid
              ? `/${p.feed_slug}/read?p=${encodeURIComponent(String(p.guid))}`
              : null;

            const thumb = postThumb(p);
            const label = kindLabel(p.category);

            const entry = (
              <article
                className={thumb ? 'entry has-thumb' : 'entry'}
                key={`${p.guid ?? p.url ?? p.title}-${i}`}
              >
                <Thumb src={thumb} href={href} />

                <h3>{href ? <a href={href}>{p.title}</a> : p.title}</h3>
                {p.summary && <p>{p.summary}</p>}
                <time>
                  <a href={`/${p.feed_slug}`}>{p.feed_title}</a>
                  {label && <span className="kind-tag">{label}</span>}
                </time>
              </article>
            );

            const format = postAds.get(i);
            return format ? [entry, <Ad key={`ad-${i}`} format={format} />] : [entry];
          })}
        </>
      )}

      {found && <AdBanner />}

      {query && (
        <p className="also-search">
          Also search{' '}
          <a href={kagi} rel="noopener">
            Kagi
          </a>{' '}
          — they index the small web too.
        </p>
      )}

      <Toolbar current={query || null} />
    </>
  );
}
