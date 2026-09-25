import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../lib/db.js';
import { AD_TEXT, adPlan } from '../lib/ads.js';
import { CATEGORIES, listHref, viewName } from '../lib/categories.js';
import Ad from './Ad.jsx';
import AdBanner from './AdBanner.jsx';
import ListFilter from './ListFilter.jsx';
import PlayButton from './PlayButton.jsx';
import SubscribeLinks from './SubscribeLinks.jsx';
import { FILTER_FROM } from '../lib/listFilter.js';
import { SUBSCRIBE_FORMATS } from '../lib/subscribe.js';
import { lanesOffered, trackFor } from '../lib/queue.js';
import Thumb, { Avatar } from './Thumb.jsx';
import { feedImage, postThumb } from '../lib/thumbs.js';
import { jsonLdScript } from '../lib/jsonld.js';
import { humanGap } from '../lib/freshness.js';

/** Feeds per category page. Matches the home page's run length. */
export const PAGE_SIZE = 60;

/**
 * What a river view offers to subscribe to: the documents, then the playlists.
 *
 * The playlists are only honest here. A directory listing's `.m3u` would be a
 * download that turns out to hold nothing — the entries are feeds, and a feed
 * is not a file — which is the refusal directoryRiver still makes for every
 * category that does not publish its entries at this address.
 */
const RIVER_FORMATS = [...SUBSCRIBE_FORMATS, 'm3u', 'pls'];

// The category table moved to lib so route handlers can read it without
// importing React. Re-exported here because ten pages already import it from
// this module, and moving a data table is not a reason to touch all of them.
//
// `viewName` and `listHref` live there for a second reason on top of that one:
// a `.jsx` file cannot be loaded by `node --test`, so anything in here is
// untestable by construction. They are URL parsing, which is exactly the sort
// of thing that should have tests.
export { CATEGORIES, listHref, viewName };

/**
 * Read `?page=` as a 1-based page number.
 *
 * Anything unusable is page 1 rather than an error: the parameter is in a URL
 * people edit and share, and a directory listing has no reason to refuse to
 * render over it.
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function pageNumber(raw) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(n) && n > 1 ? n : 1;
}

/**
 * One category of the directory, paged — as a river of entries or as a list of
 * the feeds that publish them.
 *
 * The two views answer different questions and the difference is the reason
 * both exist. A category page has always listed *feeds*, which is the right
 * answer to "who is in this directory" and the wrong one to "what is new" —
 * the ordering there is when we indexed a show, so a podcast network's busiest
 * week is invisible on the page named after it. `view="latest"` is the other
 * question, and it is the default wherever it is offered.
 *
 * @param {{ kind: string, page?: number, view?: 'latest'|'shows' }} props
 */
export default async function CategoryIndex({ kind, page = 1, view = 'shows' }) {
  const category = CATEGORIES[kind];
  const client = db();
  const river = view === 'latest' && Boolean(category.river);
  const offset = (page - 1) * PAGE_SIZE;

  // One extra row in river mode, never rendered: it is how the pager knows
  // there is another page without paying for a count over the item table, which
  // is the aggregate the whole query is shaped to avoid. See latestItems.
  const [rows, total, entries] = await Promise.all([
    river
      ? Promise.resolve([])
      : // Ordered by when each feed last published, not by when we indexed it.
        // Arrival order is meaningless to a reader and actively misleading at
        // this size: the top of a category was whatever the importer reached
        // last, so a directory of live shows opened on ones silent since
        // August. Feeds we have never read keep their arrival order and follow
        // the dated ones — see listFeedsByPublished.
        q.listFeeds(client, { kind, limit: PAGE_SIZE, offset, order: 'published' }),
    q.countFeeds(client, false, kind),
    river
      ? q.latestItems(client, { kinds: [kind], limit: PAGE_SIZE + 1, offset })
      : Promise.resolve([]),
  ]);

  const items = entries.slice(0, PAGE_SIZE);
  const hasMore = entries.length > PAGE_SIZE;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const listed = river ? items : rows;
  const ads = adPlan(listed.length, { first: 11, every: 24, max: 2 });

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${category.heading} · RSS Amplifier`,
    description: category.lede,
    url: `${siteUrl()}${category.path}`,
    hasPart: river
      ? items.slice(0, 20).map((p) => ({
          '@type': category.entrySchemaType ?? 'CreativeWork',
          name: String(p.title ?? ''),
          url: `${siteUrl()}/${p.feed_slug}/read?p=${encodeURIComponent(String(p.guid))}`,
          datePublished: p.published_at ? String(p.published_at) : undefined,
          partOfSeries: { '@type': category.schemaType, name: String(p.feed_title ?? '') },
        }))
      : rows.slice(0, 20).map((f) => ({
          '@type': category.schemaType,
          name: f.title,
          url: `${siteUrl()}/${f.slug}`,
        })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />

      <h1>{category.heading}</h1>
      <p className="lede">{category.lede}</p>

      {/* The two questions, side by side, in the same nav the topic pages use
          for their sub-groups. Both are real addresses rather than a toggle
          that only works with JavaScript, because a crawler has to be able to
          reach the directory of feeds — it is what every feed page links back
          from. */}
      {category.river && (
        <nav className="topic-groups" aria-label={`${category.heading} views`}>
          <a
            href={category.path}
            aria-current={river ? 'page' : undefined}
            className={river ? 'is-current' : undefined}
          >
            Newest {category.item}
          </a>
          <a
            href={`${category.path}?view=shows`}
            aria-current={river ? undefined : 'page'}
            className={river ? undefined : 'is-current'}
          >
            All {category.noun} <span>{total}</span>
          </a>
        </nav>
      )}

      {/* This page, in a form a reader can be told about instead of having to
          come back and check — and it follows the view, because a feed that
          disagreed with the page advertising it would be worse than none.

          The river adds the playlist formats: /podcasts.m3u is the newest
          episode of every show in one file, which is the most useful thing
          that address could mean and is only possible now the entries are
          what this page is made of. */}
      <SubscribeLinks
        base={category.path}
        query={river ? '' : '?view=shows'}
        what={river ? `the newest ${category.item}` : `the ${category.noun} directory`}
        formats={river ? RIVER_FORMATS : SUBSCRIBE_FORMATS}
      />

      <Ad format={AD_TEXT} />

      <h2>
        {river ? (
          <>
            {page === 1 ? `Newest ${category.item}` : `Page ${page}`}{' '}
            <span className="pill">
              across {total} {total === 1 ? category.one : category.noun}
            </span>
          </>
        ) : (
          <>
            {page === 1 ? `By latest ${category.entry}` : `Page ${page}`}{' '}
            <span className="pill">
              {total} {total === 1 ? category.one : category.noun}
            </span>
          </>
        )}
      </h2>

      {/* Narrows the page you are on, not the category: sixty rows is a lot to
          read through for one name, and the pager is still how you reach the
          rest of them. */}
      {listed.length >= FILTER_FROM && (
        <ListFilter
          target={river ? 'article.entry' : '.feed-list .feed-row'}
          noun={river ? category.entry : category.one}
          plural={river ? category.item : category.noun}
          searchHref="/search?q="
        />
      )}

      {listed.length === 0 ? (
        <p className="empty">
          {page > 1 ? (
            <>
              This page is past the end of the list.{' '}
              <a href={listHref(category.path, view, 1)}>Back to the start.</a>
            </>
          ) : river ? (
            // A category with feeds in it but nothing in the river is not empty,
            // it is quiet — and the directory of shows is still worth offering.
            total > 0 ? (
              <>
                Nothing published recently. The {category.noun} are still here —{' '}
                <a href={`${category.path}?view=shows`}>browse all {total}</a>.
              </>
            ) : (
              <>
                Nothing in this category yet. <a href="/submit">Add a feed</a> and its{' '}
                {category.item} will show up here.
              </>
            )
          ) : category.curated ? (
            // Says why it is empty rather than implying nobody has got round
            // to it: this category cannot fill itself, and a reader who
            // submits a feed expecting it to land here should know that.
            <>
              Nothing here yet. This category is curated — no feed says in its own markup that it
              belongs — so it fills up from a list rather than from the crawler.{' '}
              <a href="/submit">Send one in</a> and it can be added.
            </>
          ) : (
            <>
              Nothing in this category yet. <a href="/submit">Add a feed</a> and the crawler will
              file it here if it belongs.
            </>
          )}
        </p>
      ) : river ? (
        items.flatMap((p, i) => {
          // What the docked player could carry, if anything. Built from the row
          // the river already returned — no second query per episode, which on
          // a page of sixty would be sixty.
          const track = trackFor(p, {
            slug: String(p.feed_slug),
            feedTitle: String(p.feed_title ?? ''),
            entryId: p.item_id ? String(p.item_id) : null,
          });
          const thumb = postThumb(p);
          const readHref = `/${p.feed_slug}/read?p=${encodeURIComponent(String(p.guid))}`;

          const entry = (
            <article
              className={thumb ? 'entry has-thumb' : 'entry'}
              key={`${p.feed_slug}-${p.guid}`}
            >
              <Thumb src={thumb} href={readHref} />

              <h3>
                <a href={readHref}>{String(p.title ?? 'Untitled')}</a>
              </h3>
              {p.summary && <p>{String(p.summary)}</p>}

              {/* Whose it is, first. A river of sixty episodes from sixty shows
                  is unreadable without it, and it is the one link on the row
                  that leads to more of the same. */}
              <p className="meta">
                <a href={`/${p.feed_slug}`}>{String(p.feed_title ?? '')}</a>
                {p.published_at ? ` · ${formatDate(p.published_at)}` : ''}
              </p>

              {track && (
                <div className="entry-actions">
                  <PlayButton track={track} lane={lanesOffered(p)[0]} href={readHref} />
                </div>
              )}
            </article>
          );

          const format = ads.get(i);
          return format ? [entry, <Ad key={`ad-${i}`} format={format} inFeed />] : [entry];
        })
      ) : (
        <div className="feed-list">
          {rows.flatMap((f, i) => {
            const row = (
              <a className="feed-row" key={String(f.slug)} href={`/${f.slug}`}>
                <Avatar src={feedImage(f)} title={f.title} slug={f.slug} />
                <h3>{f.title}</h3>
                {f.description && <p>{f.description}</p>}
                <div className="feed-meta">
                  {f.site_url && <span>{hostOf(String(f.site_url))}</span>}
                  <span>
                    {f.item_count} {category.item}
                  </span>
                  {/* What the list is now sorted by, said on the row. An order
                      a reader cannot see is indistinguishable from no order,
                      and this is the column that tells them whether a show is
                      still going. */}
                  <span title={gapTitle(f.last_published_at)}>
                    {f.last_published_at
                      ? `Latest ${category.entry} ${formatDate(f.last_published_at)}`
                      : 'Not yet read'}
                  </span>
                </div>
              </a>
            );

            const format = ads.get(i);
            return format ? [row, <Ad key={`ad-${i}`} format={format} inFeed />] : [row];
          })}
        </div>
      )}

      {/* Plain links, both ends labelled: the pager is the only way through a
          category of this size without JavaScript, and a bare arrow says
          nothing to a screen reader or to a crawler deciding whether to follow
          it.

          The river's end is read off one extra row rather than a page count,
          because counting a category's items is the scan latestItems exists to
          avoid — so it says which page you are on and not how many there are. */}
      {(river ? page > 1 || hasMore : lastPage > 1) && (
        <nav className="pager" aria-label={`${category.heading} pages`}>
          {page > 1 ? (
            <a href={listHref(category.path, view, page - 1)} rel="prev">
              ← Newer
            </a>
          ) : (
            <span className="disabled">← Newer</span>
          )}
          <span className="pill">{river ? `Page ${page}` : `Page ${page} of ${lastPage}`}</span>
          {(river ? hasMore : page < lastPage) ? (
            <a href={listHref(category.path, view, page + 1)} rel="next">
              Older →
            </a>
          ) : (
            <span className="disabled">Older →</span>
          )}
        </nav>
      )}

      <p className="hint">
        Machine-readable: <a href={`/api/feeds?kind=${kind}`}>JSON</a> ·{' '}
        <a href={`/opml?kind=${kind}`}>OPML</a>
      </p>

      <AdBanner />
    </>
  );
}

/**
 * @param {unknown} iso
 * @returns {string}
 */
function formatDate(iso) {
  if (!iso) return 'undated';
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return 'undated';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * "3 days ago", for the tooltip on a row's date.
 *
 * The date itself is what the row shows — it is the fact, and it does not go
 * stale in a cache. How long ago that was is what the reader is actually
 * working out, so it is one hover away rather than absent.
 *
 * @param {unknown} iso
 * @returns {string|undefined}
 */
function gapTitle(iso) {
  if (!iso) return undefined;
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return undefined;
  return `${humanGap(Date.now() - t)} ago`;
}

/**
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
