import { notFound } from 'next/navigation';
import { q } from '@rssamplifier/db';
import { SYNDICATION_FORMATS, topicSlug } from '@rssamplifier/feed';

import { db, siteUrl } from '../../../lib/db.js';
import { AD_TEXT, adPlan } from '../../../lib/ads.js';
import Ad from '../../Ad.jsx';
import AdBanner from '../../AdBanner.jsx';
import { pageNumber } from '../../CategoryIndex.jsx';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 60;

/**
 * The extensions this page is also available as, in the order they are offered.
 *
 * Ordered by how likely a visitor is to want one rather than alphabetically:
 * the three feed formats first, then the two playlists, which only make sense
 * on a topic that has media in it.
 *
 * `.xml` is a supported alias for `.rss` and is deliberately not listed — it is
 * the same document under a second name, and offering both invites the question
 * of how they differ.
 */
const OFFERED_FORMATS = ['rss', 'atom', 'json', 'm3u', 'pls'];

/**
 * What each extension is, for the link's title attribute.
 *
 * The links themselves are the bare extension: it is what the reader is going
 * to type or paste, it is short enough to sit in one subtle row, and ".rss"
 * needs no more explanation than that to the people who want it.
 */
const FORMAT_TITLES = {
  rss: 'RSS 2.0 — recent posts on this topic',
  atom: 'Atom 1.0 — recent posts on this topic',
  json: 'JSON Feed 1.1 — recent posts on this topic',
  m3u: 'M3U playlist — the playable media on this topic',
  pls: 'PLS playlist — the playable media on this topic',
};

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

  const page = `${siteUrl()}/topics/${encodeURIComponent(topic.slug)}`;

  return {
    title: topic.keyword,
    description: `${topic.feedCount} blogs and podcasts in the RSS Amplifier directory write about ${topic.keyword}.`,
    alternates: {
      canonical: page,
      // Autodiscovery, which is how a browser extension or a reader offers to
      // subscribe from the page itself rather than making somebody find the
      // link. Only the two XML formats go here: `types` renders
      // `<link rel="alternate">`, and a reader that follows an unexpected type
      // reports a broken feed.
      types: {
        'application/rss+xml': [{ url: `${page}.rss`, title: `${topic.keyword} — RSS` }],
        'application/atom+xml': [{ url: `${page}.atom`, title: `${topic.keyword} — Atom` }],
        'application/feed+json': [{ url: `${page}.json`, title: `${topic.keyword} — JSON Feed` }],
      },
    },
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
      '@type': f.category === 'podcast' ? 'PodcastSeries' : 'Blog',
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

      {/* This page, as something to subscribe to. Kept to the bare extensions
          and set quietly under the heading: a reader who wants a feed knows
          what ".rss" means and is scanning for exactly that, and everyone else
          should be able to read past it without it competing with the list. */}
      <p className="format-links">
        <span>Subscribe:</span>
        {OFFERED_FORMATS.map((ext) => (
          <a
            key={ext}
            href={`/topics/${encodeURIComponent(topic.slug)}.${ext}`}
            title={FORMAT_TITLES[ext]}
            // The advisory type a reader uses to decide it can handle the link
            // before following it. Without the charset: the attribute takes a
            // MIME type, and the parameter belongs on the response header.
            type={SYNDICATION_FORMATS.get(ext)?.type.split(';')[0]}
          >
            {`.${ext}`}
          </a>
        ))}
      </p>

      <Ad format={AD_TEXT} />

      <div className="feed-list">
        {rows.flatMap((f, i) => {
          const row = (
            <a className="feed-row" key={String(f.slug)} href={`/${f.slug}`}>
              <h3>{f.title}</h3>
              {f.description && <p>{f.description}</p>}
              <div className="feed-meta">
                <span>{f.category === 'podcast' ? 'Podcast' : 'Blog'}</span>
                {/* Where this feed's place on the page came from. A publisher's
                    own tag is a different claim from a word we counted, and the
                    reader deserves to know which they are looking at. */}
                <span>{f.source === 'category' ? 'tagged by the author' : `${f.count} mentions`}</span>
                <span>
                  {f.item_count} {f.category === 'podcast' ? 'episodes' : 'posts'}
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

      {/* The feed links above are the posts; this one is the directory listing
          — who covers the topic, rather than what they published. Two different
          documents, so both are offered and both say which they are. */}
      <p className="hint">
        Machine-readable:{' '}
        <a href={`/api/topics/${encodeURIComponent(topic.slug)}`}>this list of feeds, as JSON</a> ·{' '}
        <a href={`/topics/${encodeURIComponent(topic.slug)}.json`}>their recent posts, as JSON Feed</a>{' '}
        · <a href="/topics">all topics</a>
      </p>

      <AdBanner />
    </>
  );
}
