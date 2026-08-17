import { authors } from '@rssamplifier/db';

import { db, siteUrl } from '../../lib/db.js';
import { AD_TEXT } from '../../lib/ads.js';
import Ad from '../Ad.jsx';
import AdBanner from '../AdBanner.jsx';
import AuthorLinks from '../AuthorLinks.jsx';
import { pageNumber } from '../CategoryIndex.jsx';

export const dynamic = 'force-dynamic';

/** Authors per page. A card with a name, a line of bio and a row of links. */
const PAGE_SIZE = 60;

/**
 * The floor a person must clear to be listed.
 *
 * Everything the crawler finds is stored, because a weak signal today is
 * evidence tomorrow when a second source agrees with it. Not everything found
 * is published: this page is about real people, and a byline scraped off one
 * page at 0.4 confidence is a guess. 0.6 is the confidence of an item byline
 * corroborated by nothing else, which is the weakest claim worth showing.
 */
const MIN_CONFIDENCE = 0.6;

export async function generateMetadata({ searchParams }) {
  const page = pageNumber((await searchParams).page);

  return {
    title: page === 1 ? 'Authors' : `Authors · page ${page}`,
    description:
      'The people behind the feeds in the directory, and where else they publish — their own sites, their Mastodon and Bluesky accounts, their links pages.',
    alternates: {
      canonical: page === 1 ? `${siteUrl()}/authors` : `${siteUrl()}/authors?page=${page}`,
    },
  };
}

/**
 * The people index.
 *
 * The directory has always been a list of feeds, and a feed is a publication
 * rather than a person. This is the other way of walking the same data: who
 * writes the small web, and how to reach them.
 *
 * Nothing on this page was scraped out of anybody's private life. Every link
 * below is one the author published on their own site, marked up — with
 * `rel="me"`, an h-card or JSON-LD — as a statement about where else they are.
 *
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function AuthorsPage({ searchParams }) {
  const params = await searchParams;
  const page = pageNumber(params.page);
  const network = typeof params.network === 'string' ? params.network : '';
  const query = typeof params.q === 'string' ? params.q : '';
  const client = db();

  const [people, total, stats] = await Promise.all([
    authors.listAuthors(client, {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      minConfidence: MIN_CONFIDENCE,
      network,
      query,
    }),
    authors.countAuthors(client, { minConfidence: MIN_CONFIDENCE }),
    authors.authorStats(client, { minConfidence: MIN_CONFIDENCE }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = Boolean(network || query);
  const qs = (n) => {
    const parts = [];
    if (n > 1) parts.push(`page=${n}`);
    if (network) parts.push(`network=${encodeURIComponent(network)}`);
    if (query) parts.push(`q=${encodeURIComponent(query)}`);
    return parts.length ? `/authors?${parts.join('&')}` : '/authors';
  };

  return (
    <>
      <h1>Authors</h1>
      <p className="lede">
        The people behind the feeds. Every link here is one the author published on their own site
        — a <code>rel=&quot;me&quot;</code> set, an h-card, a links page — which is the small web&rsquo;s
        own way of saying where else to find someone.
      </p>

      {/* A plain GET form, like every other control on the site: it works with
          JavaScript off and the result is a URL somebody can keep. */}
      <form className="submit-box" method="get" action="/authors">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search by name…"
          aria-label="Author name"
        />
        <div className="author-filters">
          <label>
            <span>Reachable on</span>
            <select name="network" defaultValue={network}>
              <option value="">anywhere</option>
              <option value="website">their own site</option>
              <option value="email">email</option>
              <option value="fediverse">Mastodon</option>
              <option value="bluesky">Bluesky</option>
              <option value="github">GitHub</option>
              <option value="linktree">a links page</option>
            </select>
          </label>
          <div className="submit-actions">
            <button type="submit">Filter</button>
            {filtered && <a href="/authors">Clear</a>}
          </div>
        </div>
      </form>

      <Ad format={AD_TEXT} />

      <h2>
        {filtered ? 'Matching' : page === 1 ? 'Most complete' : `Page ${page}`}{' '}
        <span className="pill">
          {total} {total === 1 ? 'author' : 'authors'}
        </span>
      </h2>

      {people.length === 0 ? (
        <p className="empty">
          {filtered
            ? 'Nobody in the directory matches that yet.'
            : `No authors yet. The crawler works out who writes a feed as it goes, and has looked at
               ${stats.feedsChecked} feeds so far.`}
        </p>
      ) : (
        <ul className="author-grid">
          {people.map((person) => (
            <li key={String(person.id)}>
              <h3>
                <a href={`/authors/${encodeURIComponent(String(person.slug))}`}>{person.name}</a>
              </h3>
              {person.bio && <p>{person.bio}</p>}
              <p className="hint">
                {person.feed_count} {Number(person.feed_count) === 1 ? 'feed' : 'feeds'}
              </p>
              <AuthorLinks links={person.links} />
            </li>
          ))}
        </ul>
      )}

      {lastPage > 1 && (
        <nav className="pager" aria-label="Author pages">
          {page > 1 ? (
            <a href={qs(page - 1)} rel="prev">
              ← More complete
            </a>
          ) : (
            <span className="disabled">← More complete</span>
          )}
          <span className="pill">
            Page {page} of {lastPage}
          </span>
          {page < lastPage ? (
            <a href={qs(page + 1)} rel="next">
              Less complete →
            </a>
          ) : (
            <span className="disabled">Less complete →</span>
          )}
        </nav>
      )}

      <p className="hint">
        {stats.reachable} of {stats.authors} can be reached somewhere, and {stats.feedsWithLinks}{' '}
        blogs publish an account without naming anybody. Machine-readable:{' '}
        <a href="/api/authors">JSON</a>
      </p>

      <AdBanner />
    </>
  );
}
