import { notFound } from 'next/navigation';
import { q } from '@rssamplifier/db';

import { db, siteUrl } from '../../lib/db.js';
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

  const [posts, nav] = await Promise.all([
    q.itemsForFeed(client, String(feed.id), 50),
    q.neighbours(client, String(feed.created_at)),
  ]);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: feed.title,
    description: feed.description ?? undefined,
    url: feed.site_url ?? `${siteUrl()}/${feed.slug}`,
    blogPost: posts.slice(0, 20).map((p) => ({
      '@type': 'BlogPosting',
      headline: p.title,
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

      <p className="eyebrow">Blog</p>
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
        <span>{feed.item_count} posts</span>
      </div>

      {feed.status === 'dead' && (
        <p className="notice">
          This feed stopped responding, so we no longer crawl it. The archive below is what we
          collected while it was live.
        </p>
      )}

      <h2>Latest posts</h2>

      {posts.length === 0 ? (
        <p className="empty">No posts collected yet — the crawler will pick this up shortly.</p>
      ) : (
        posts.map((p) => (
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
        ))
      )}

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
