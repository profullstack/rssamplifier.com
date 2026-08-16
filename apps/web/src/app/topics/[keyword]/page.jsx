import { notFound } from 'next/navigation';
import { q } from '@rssamplifier/db';
import { topicSlug } from '@rssamplifier/feed';

import { db, siteUrl } from '../../../lib/db.js';
import { AD_TEXT, adPlan } from '../../../lib/ads.js';
import Ad from '../../Ad.jsx';
import AdBanner from '../../AdBanner.jsx';
import { pageNumber } from '../../CategoryIndex.jsx';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 60;

/**
 * Read the keyword out of the URL as a topic slug.
 *
 * Run through topicSlug rather than trusted: /topics/Home%20Lab and
 * /topics/home-lab are the same request, and normalising here means the second
 * spelling finds the page instead of 404ing on a slug nobody stored.
 *
 * @param {string} raw
 * @returns {string}
 */
function slugOf(raw) {
  return topicSlug(decodeURIComponent(String(raw ?? '')));
}

/**
 * @param {{ params: Promise<{ keyword: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { keyword } = await params;
  const topic = await q.topicBySlug(db(), slugOf(keyword));
  if (!topic) return { title: 'Not found' };

  return {
    title: topic.keyword,
    description: `${topic.feedCount} blogs and podcasts in the RSS Amplifier directory write about ${topic.keyword}.`,
    alternates: { canonical: `${siteUrl()}/topics/${encodeURIComponent(topic.slug)}` },
  };
}

/**
 * One topic: every feed in the directory that writes about it.
 *
 * @param {{ params: Promise<{ keyword: string }>, searchParams: Promise<Record<string, string|string[]|undefined>> }} props
 */
export default async function TopicPage({ params, searchParams }) {
  const { keyword } = await params;
  const slug = slugOf(keyword);
  const page = pageNumber((await searchParams).page);
  const client = db();

  const topic = await q.topicBySlug(client, slug);
  if (!topic) notFound();

  const rows = await q.feedsForTopic(client, slug, {
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const lastPage = Math.max(1, Math.ceil(topic.feedCount / PAGE_SIZE));
  const ads = adPlan(rows.length, { first: 11, every: 24, max: 2 });

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: topic.keyword,
    about: { '@type': 'Thing', name: topic.keyword },
    url: `${siteUrl()}/topics/${encodeURIComponent(topic.slug)}`,
    hasPart: rows.slice(0, 20).map((f) => ({
      '@type': f.kind === 'podcast' ? 'PodcastSeries' : 'Blog',
      name: f.title,
      url: `${siteUrl()}/${f.slug}`,
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <p className="eyebrow">
        <a href="/topics">Topic</a>
      </p>
      <h1>{topic.keyword}</h1>
      <p className="lede">
        {topic.feedCount === 1
          ? 'One feed in the directory covers this.'
          : `${topic.feedCount} feeds in the directory cover this.`}
      </p>

      <Ad format={AD_TEXT} />

      <div className="feed-list">
        {rows.flatMap((f, i) => {
          const row = (
            <a className="feed-row" key={String(f.slug)} href={`/${f.slug}`}>
              <h3>{f.title}</h3>
              {f.description && <p>{f.description}</p>}
              <div className="feed-meta">
                <span>{f.kind === 'podcast' ? 'Podcast' : 'Blog'}</span>
                {/* Where this feed's place on the page came from. A publisher's
                    own tag is a different claim from a word we counted, and the
                    reader deserves to know which they are looking at. */}
                <span>{f.source === 'category' ? 'tagged by the author' : `${f.count} mentions`}</span>
                <span>
                  {f.item_count} {f.kind === 'podcast' ? 'episodes' : 'posts'}
                </span>
              </div>
            </a>
          );

          const format = ads.get(i);
          return format ? [row, <Ad key={`ad-${i}`} format={format} inFeed />] : [row];
        })}
      </div>

      {lastPage > 1 && (
        <nav className="pager" aria-label="Topic pages">
          {page > 1 ? (
            <a
              href={
                page === 2
                  ? `/topics/${encodeURIComponent(topic.slug)}`
                  : `/topics/${encodeURIComponent(topic.slug)}?page=${page - 1}`
              }
              rel="prev"
            >
              ← Previous
            </a>
          ) : (
            <span className="disabled">← Previous</span>
          )}
          <span className="pill">
            Page {page} of {lastPage}
          </span>
          {page < lastPage ? (
            <a href={`/topics/${encodeURIComponent(topic.slug)}?page=${page + 1}`} rel="next">
              Next →
            </a>
          ) : (
            <span className="disabled">Next →</span>
          )}
        </nav>
      )}

      <p className="hint">
        Machine-readable:{' '}
        <a href={`/api/topics/${encodeURIComponent(topic.slug)}`}>JSON</a> ·{' '}
        <a href="/topics">all topics</a>
      </p>

      <AdBanner />
    </>
  );
}
