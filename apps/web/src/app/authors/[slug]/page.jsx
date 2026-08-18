import { notFound } from 'next/navigation';
import { authors } from '@rssamplifier/db';

import { db, siteUrl } from '../../../lib/db.js';
import AdBanner from '../../AdBanner.jsx';
import AuthorLinks from '../../AuthorLinks.jsx';
import { CATEGORIES } from '../../CategoryIndex.jsx';

export const dynamic = 'force-dynamic';

/**
 * @param {{ params: Promise<{ slug: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { slug } = await params;
  const person = await authors.authorBySlug(db(), slug);
  if (!person) return { title: 'Not found' };

  const titles = (person.feeds ?? []).map((f) => String(f.title));

  return {
    title: String(person.name),
    description: person.bio
      ? String(person.bio)
      : titles.length
        ? `${person.name} publishes ${titles.slice(0, 3).join(', ')}.`
        : `${person.name} in the rssamplifier directory.`,
    alternates: { canonical: `${siteUrl()}/authors/${slug}` },
  };
}

/**
 * One person's page: what they publish, and where else they are.
 *
 * The JSON-LD is a `Person` with `sameAs`, which is deliberately the same
 * vocabulary the extractor reads. A directory that consumes structured data
 * and then publishes prose would be taking from the small web without putting
 * anything back; this way the next crawler along — ours or anybody else's —
 * gets the answer in the form it was asked in.
 *
 * @param {{ params: Promise<{ slug: string }> }} props
 */
export default async function AuthorPage({ params }) {
  const { slug } = await params;
  const person = await authors.authorBySlug(db(), slug);
  if (!person) notFound();

  const feeds = person.feeds ?? [];
  const links = person.links ?? [];

  // What they have published lately, read off their own feeds' ids rather than
  // searched for -- see `postsByAuthor`. A profile that lists the blogs but not
  // the writing is a card catalogue entry; the point of a page about a person
  // is what they wrote.
  const posts = await authors.postsByAuthor(
    db(),
    feeds.map((f) => String(f.id ?? '')).filter(Boolean),
  );

  // Their own site is a link like any other in the row below, but it is also
  // the thing schema.org means by `url`, so it is pulled out here.
  const homepage =
    person.site_url ?? links.find((l) => l.network === 'website')?.url ?? undefined;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: person.name,
    description: person.bio ?? undefined,
    image: person.avatar_url ?? undefined,
    url: homepage,
    // Email is republished only when the author published it themselves as a
    // personal address; role mailboxes never reach this table. See
    // packages/feed/src/identity.js, which drops them at extraction.
    email: person.email ?? undefined,
    sameAs: links.filter((l) => l.network !== 'email').map((l) => l.url),
    ...(feeds.length
      ? {
          author: feeds.map((feed) => ({
            '@type': 'Blog',
            name: feed.title,
            url: `${siteUrl()}/${feed.slug}`,
          })),
        }
      : {}),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <p className="eyebrow">
        <a href="/authors">Authors</a>
      </p>

      {/* The profile proper: picture, name, bio, and the links as things to
          press. This is the shape everybody already reads as "a page about a
          person", and it is worth matching rather than inventing -- somebody
          arriving from a byline is looking for who this is and where else to
          find them, in that order. */}
      <header className="profile">
        {person.avatar_url && (
          // Their own published avatar, from an h-card or structured data. It
          // was in this page's JSON-LD from the start and never rendered, which
          // is an odd way round: the machines could see their face and the
          // people could not.
          //
          // A plain <img>: the picture is on somebody else's host, and Next's
          // optimiser would need every author's domain allow-listed in advance,
          // which for an open directory is a list that cannot be written.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="profile-avatar"
            src={String(person.avatar_url)}
            alt=""
            width={96}
            height={96}
            loading="lazy"
            // A dead avatar URL is common -- people move hosts -- and the
            // broken-image icon is worse than no picture at all.
            referrerPolicy="no-referrer"
          />
        )}

        <h1>{person.name}</h1>
        {person.bio && <p className="profile-bio">{person.bio}</p>}
      </header>

      <AuthorLinks links={links} prominent />

      <h2>
        {feeds.length === 1 ? 'Publishes' : 'Publishes'}{' '}
        <span className="pill">
          {feeds.length} {feeds.length === 1 ? 'feed' : 'feeds'}
        </span>
      </h2>

      {feeds.length === 0 ? (
        <p className="empty">
          Nothing in the directory is credited to them any more — a feed they wrote may have been
          removed since.
        </p>
      ) : (
        <ul className="feed-list">
          {feeds.map((feed) => {
            const category = CATEGORIES[String(feed.kind)] ?? CATEGORIES.blog;
            return (
              <li key={String(feed.slug)}>
                <h3>
                  <a href={`/${encodeURIComponent(String(feed.slug))}`}>{feed.title}</a>
                </h3>
                {feed.description && <p>{feed.description}</p>}
                <p className="hint">
                  {feed.item_count} {category.item}
                  {feed.role === 'owner' ? ' · theirs' : ' · contributor'}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {posts.length > 0 && (
        <>
          <h2>Lately</h2>
          <ul className="post-list">
            {posts.map((post) => (
              <li key={`${post.feed_slug}-${post.guid}`}>
                <h3>
                  <a
                    href={`/${encodeURIComponent(String(post.feed_slug))}/read?p=${encodeURIComponent(String(post.guid))}`}
                  >
                    {post.title}
                  </a>
                </h3>
                <p className="hint">
                  <a href={`/${encodeURIComponent(String(post.feed_slug))}`}>{post.feed_title}</a>
                  {post.published_at && (
                    <>
                      {' · '}
                      <time dateTime={String(post.published_at)}>
                        {String(post.published_at).slice(0, 10)}
                      </time>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Said plainly, on the page it is about. Somebody who finds themselves
          here should be able to see immediately where this came from and that
          it is all their own published markup — and, if they would rather not
          be listed, who to tell. */}
      <p className="hint">
        Everything on this page was read from markup {person.name} published — a{' '}
        <code>rel=&quot;me&quot;</code> link, an h-card, or the feed&rsquo;s own author element.
        Nothing was inferred from anywhere else. To correct or remove it,{' '}
        <a href="/contact">get in touch</a>. Machine-readable:{' '}
        <a href={`/api/authors/${encodeURIComponent(slug)}`}>JSON</a>
      </p>

      <AdBanner />
    </>
  );
}
