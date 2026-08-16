import { notFound } from 'next/navigation';

import { db, siteUrl } from '../../lib/db.js';
import Toolbar from '../Toolbar.jsx';

export const dynamic = 'force-dynamic';

/**
 * @param {{ params: Promise<{ slug: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { slug } = await params;
  const sb = db();
  const { data: feed } = await sb
    .from('feeds')
    .select('title, description')
    .eq('slug', slug)
    .maybeSingle();

  if (!feed) return { title: 'Not found' };

  return {
    title: feed.title,
    description: feed.description ?? `Latest posts from ${feed.title}.`,
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
  const sb = db();

  const { data: feed } = await sb.from('feeds').select('*').eq('slug', slug).maybeSingle();
  if (!feed) notFound();

  const { data: items } = await sb
    .from('feed_items')
    .select('guid, url, title, summary, author, published_at')
    .eq('feed_id', feed.id)
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(50);

  // Neighbours for the toolbar, ordered the same way the index is.
  const [{ data: prevRows }, { data: nextRows }] = await Promise.all([
    sb
      .from('feeds')
      .select('slug')
      .gt('created_at', feed.created_at)
      .neq('status', 'dead')
      .order('created_at', { ascending: true })
      .limit(1),
    sb
      .from('feeds')
      .select('slug')
      .lt('created_at', feed.created_at)
      .neq('status', 'dead')
      .order('created_at', { ascending: false })
      .limit(1),
  ]);

  const posts = items ?? [];

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

      <div className="feed-meta" style={{ marginBottom: '1.5rem' }}>
        {feed.site_url && (
          <a href={feed.site_url} rel="noopener">
            {hostOf(feed.site_url)} ↗
          </a>
        )}
        <a href={feed.feed_url} rel="noopener">
          RSS feed ↗
        </a>
        <span>{feed.item_count} posts</span>
        {feed.status === 'error' && <span>last crawl failed</span>}
        {feed.status === 'dead' && <span>no longer updating</span>}
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
        <div>
          {posts.map((p) => (
            <article className="entry" key={p.guid}>
              <h3>
                {p.url ? (
                  <a href={p.url} rel="noopener">
                    {p.title}
                  </a>
                ) : (
                  p.title
                )}
              </h3>
              {p.summary && <p>{p.summary}</p>}
              <time dateTime={p.published_at ?? undefined}>
                {formatDate(p.published_at)}
                {p.author ? ` · ${p.author}` : ''}
              </time>
            </article>
          ))}
        </div>
      )}

      <Toolbar
        prev={prevRows?.[0]?.slug ?? null}
        next={nextRows?.[0]?.slug ?? null}
        current={feed.title}
        siteUrl={feed.site_url}
        feedUrl={feed.feed_url}
      />
    </>
  );
}

/**
 * @param {string|null} iso
 * @returns {string}
 */
function formatDate(iso) {
  if (!iso) return 'undated';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
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
