import { notFound } from 'next/navigation';
import { q, accounts } from '@rssamplifier/db';

import { db, siteUrl } from '../../lib/db.js';
import { currentUser } from '../../lib/auth.js';
import { adPlan } from '../../lib/ads.js';
import Ad from '../Ad.jsx';
import AdBanner from '../AdBanner.jsx';
import Toolbar from '../Toolbar.jsx';

export const dynamic = 'force-dynamic';

/**
 * @param {{ params: Promise<{ slug: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { slug } = await params;
  const feed = await q.feedBySlug(db(), slug);
  if (!feed) return { title: 'Not found' };

  return {
    title: String(feed.title),
    description: feed.description ? String(feed.description) : `Latest posts from ${feed.title}.`,
    alternates: { canonical: `${siteUrl()}/${slug}` },
  };
}

/**
 * A single blog's page: who they are, and what they have published lately.
 *
 * @param {{ params: Promise<{ slug: string }> }} props
 */
export default async function FeedPage({ params }) {
  const { slug } = await params;
  const client = db();

  const feed = await q.feedBySlug(client, slug);
  if (!feed) notFound();

  const [posts, nav, user] = await Promise.all([
    q.itemsForFeed(client, String(feed.id), 50),
    q.neighbours(client, String(feed.created_at)),
    currentUser(),
  ]);

  // Only asked once we know there is someone to ask about.
  const following = user
    ? await accounts.isFollowing(client, String(user.id), String(feed.id))
    : false;

  // A blog page is the longest read on the site — up to fifty summaries — so it
  // is the one place a rectangle earns its keep, sat in the flow where somebody
  // has already stopped to read. Three units across fifty posts, alternating so
  // it never becomes a column of boxes, and none at all on a blog with only a
  // handful of entries.
  const ads = adPlan(posts.length, { first: 3, every: 12, max: 3 });

  const podcast = feed.kind === 'podcast';

  // A podcast described as a Blog is wrong in the one place a machine reads
  // this page, so the type and the property that carries the entries both
  // follow the feed's kind. The entries themselves are the same rows either
  // way — what differs is what they are called.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': podcast ? 'PodcastSeries' : 'Blog',
    name: feed.title,
    description: feed.description ?? undefined,
    url: feed.site_url ?? `${siteUrl()}/${feed.slug}`,
    webFeed: String(feed.feed_url),
    [podcast ? 'hasPart' : 'blogPost']: posts.slice(0, 20).map((p) => ({
      '@type': podcast ? 'PodcastEpisode' : 'BlogPosting',
      [podcast ? 'name' : 'headline']: p.title,
      url: p.url ?? undefined,
      datePublished: p.published_at ?? undefined,
      author: p.author ? { '@type': 'Person', name: p.author } : undefined,
      abstract: p.summary ?? undefined,
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* The eyebrow is a link, not a label: it is the only place on a feed's
          page that says which category it was filed under, so it may as well be
          the way back to the rest of that category. */}
      <p className="eyebrow">
        <a href={podcast ? '/podcasts' : '/blogs'}>{podcast ? 'Podcast' : 'Blog'}</a>
      </p>
      <h1>{feed.title}</h1>
      {feed.description && <p className="lede">{feed.description}</p>}

      <div className="feed-meta detail">
        {feed.site_url && (
          <a href={String(feed.site_url)} rel="noopener">
            {hostOf(String(feed.site_url))} ↗
          </a>
        )}
        <a href={String(feed.feed_url)} rel="noopener">
          RSS feed ↗
        </a>
        <span>
          {feed.item_count} {podcast ? 'episodes' : 'posts'}
        </span>
      </div>

      {/* A plain form, so following works with JavaScript off. A signed-out
          reader is not shown a dead button: the endpoint sends them to sign in
          and back here afterwards. */}
      <form className="follow-form" action="/api/follows" method="post">
        <input type="hidden" name="slug" value={String(feed.slug)} />
        <input type="hidden" name="action" value={following ? 'unfollow' : 'follow'} />
        {/* Following is the quiet state: it is a thing already done, and
            styling it as loudly as the call to action would make every followed
            blog shout. */}
        <button type="submit" className={following ? 'secondary-button' : ''}>
          {following ? 'Following ✓' : 'Follow'}
        </button>
      </form>

      {feed.status === 'dead' && (
        <p className="notice">
          This feed stopped responding, so we no longer crawl it. The archive below is what we
          collected while it was live.
        </p>
      )}

      <h2>{podcast ? 'Latest episodes' : 'Latest posts'}</h2>

      {posts.length === 0 ? (
        <p className="empty">
          {podcast ? 'No episodes' : 'No posts'} collected yet — the crawler will pick this up
          shortly.
        </p>
      ) : (
        posts.flatMap((p, i) => {
          const entry = (
            <article className="entry" key={String(p.guid)}>
              <h3>
                {p.url ? (
                  // Into the reader rather than straight out: the toolbar stays
                  // on screen, and the reader falls back to the original site for
                  // anything that refuses to be framed.
                  <a href={`/${slug}/read?p=${encodeURIComponent(String(p.guid))}`}>{p.title}</a>
                ) : (
                  p.title
                )}
              </h3>
              {p.summary && <p>{p.summary}</p>}
              <time dateTime={p.published_at ? String(p.published_at) : undefined}>
                {formatDate(p.published_at)}
                {p.author ? ` · ${p.author}` : ''}
              </time>
            </article>
          );

          const format = ads.get(i);
          return format ? [entry, <Ad key={`ad-${i}`} format={format} />] : [entry];
        })
      )}

      <AdBanner />

      <Toolbar
        prev={nav.prev}
        next={nav.next}
        current={String(feed.title)}
        siteUrl={feed.site_url ? String(feed.site_url) : null}
        feedUrl={String(feed.feed_url)}
      />
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
