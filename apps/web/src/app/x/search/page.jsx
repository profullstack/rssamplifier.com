import { notFound } from 'next/navigation';
import { xSource } from '@rssamplifier/social';

import { siteUrl } from '../../../lib/db.js';
import { socialFeed, socialMetadata } from '../../../lib/socialPage.js';
import AddSocialSource from '../../AddSocialSource.jsx';
import FeedPage from '../../[slug]/page.jsx';

export const dynamic = 'force-dynamic';

/**
 * An X search, at `/x/search?q=bitcoin`.
 *
 * The query stays in the query string for the reason given in the route
 * handler: X's operator syntax is passed through whole, and `from:OpenAI
 * lang:en` cannot survive being a path segment without an escaping scheme
 * nobody should have to learn to subscribe to something.
 *
 * With no `?q=` this is a form rather than a 404 — somebody who typed
 * `/x/search` was asking for the search page, and giving them one is a shorter
 * path to what they wanted than an error.
 *
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export async function generateMetadata({ searchParams }) {
  const query = String((await searchParams).q ?? '').trim();
  const source = query ? xSource(`https://x.com/search?q=${encodeURIComponent(query)}`) : null;

  if (!source) {
    return {
      title: 'Search X',
      description: 'Turn an X search into a feed you can subscribe to.',
      alternates: { canonical: `${siteUrl()}/x/search` },
    };
  }

  const [canonical, suffix] = source.path.split('?');

  return socialMetadata({
    feed: await socialFeed(source.ref),
    // The query belongs in the canonical URL: two searches are two pages, and
    // collapsing them onto `/x/search` would tell a crawler they are one.
    canonical: `${canonical}?${suffix}`,
    label: source.title,
    network: 'x',
  });
}

/**
 * @param {{ searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function XSearchPage({ searchParams }) {
  const query = String((await searchParams).q ?? '').trim();

  if (!query) {
    return (
      <main className="prose">
        <h1>Search X</h1>
        <p>
          Any X search can be a feed. Type one below — X&rsquo;s own operators work, so{' '}
          <code>from:OpenAI lang:en</code> does what you would expect.
        </p>
        <form method="get" action="/x/search">
          <input type="search" name="q" placeholder="bitcoin" aria-label="X search" required />
          <button type="submit">Search</button>
        </form>
        <p>
          <a href="/x">Browse the X sources already here</a>
        </p>
      </main>
    );
  }

  // Cannot be null: the only thing that makes a search unparseable is an empty
  // query, and that is the branch above. Guarded anyway, because the day
  // somebody adds a length cap to the parser this is where it would surface.
  const source = xSource(`https://x.com/search?q=${encodeURIComponent(query)}`);
  if (!source) notFound();

  const feed = await socialFeed(source.ref);
  if (!feed) {
    return (
      <AddSocialSource
        network="x"
        label={source.title}
        input={source.url}
        canonical={`/x/search?q=${encodeURIComponent(query)}`}
      />
    );
  }

  return FeedPage({ params: Promise.resolve({ slug: String(feed.slug) }) });
}
