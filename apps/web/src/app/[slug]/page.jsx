import { notFound } from 'next/navigation';
import { q, accounts, queue } from '@rssamplifier/db';

import { db, siteUrl } from '../../lib/db.js';
import { currentUser } from '../../lib/auth.js';
import { adPlan } from '../../lib/ads.js';
import { lanesOffered, trackFor } from '../../lib/queue.js';
import { shareText } from '../../lib/share.js';
import Ad from '../Ad.jsx';
import AdBanner from '../AdBanner.jsx';
import FollowButton from '../FollowButton.jsx';
import PlayButton from '../PlayButton.jsx';
import QueueButton from '../QueueButton.jsx';
import Share from '../Share.jsx';
import Toolbar from '../Toolbar.jsx';
import { CATEGORIES } from '../CategoryIndex.jsx';

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
    description: feed.description
      ? String(feed.description)
      : `Latest ${(CATEGORIES[String(feed.category)] ?? CATEGORIES.blog).item} from ${feed.title}.`,
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

  const [posts, nav, topics, user] = await Promise.all([
    q.itemsForFeed(client, String(feed.id), 50),
    q.neighbours(client, String(feed.created_at)),
    q.keywordsForFeed(client, String(feed.id)),
    currentUser(),
  ]);

  // Only asked once we know there is someone to ask about.
  const [following, queued] = user
    ? await Promise.all([
        accounts.isFollowing(client, String(user.id), String(feed.id)),
        // One statement for the whole page. Asking per post would be fifty
        // round trips to decide what fifty buttons say.
        queue.lanesForItems(
          client,
          String(user.id),
          posts.map((p) => String(p.id)),
        ),
      ])
    : [false, /** @type {Record<string, ('read'|'listen'|'watch')[]>} */ ({})];

  // A blog page is the longest read on the site — up to fifty summaries — so it
  // is the one place a rectangle earns its keep, sat in the flow where somebody
  // has already stopped to read. Three units across fifty posts, alternating so
  // it never becomes a column of boxes, and none at all on a blog with only a
  // handful of entries.
  const ads = adPlan(posts.length, { first: 3, every: 12, max: 3 });

  const podcast = feed.category === 'podcast';

  // What this feed's own category calls itself, so the page agrees with the
  // directory it was filed in. Falls back to Blogs for a category this build
  // has never heard of — a row written by a newer deploy, say — because an
  // eyebrow linking nowhere is worse than one that is merely unspecific.
  const category = CATEGORIES[String(feed.category)] ?? CATEGORIES.blog;

  // This page, absolute, and deliberately ours rather than the blog's own site:
  // sharing from here should land somebody on the archive, the follow button
  // and the reader, which is the part they cannot get to from the blog.
  const pageUrl = `${siteUrl()}/${slug}`;

  // A podcast described as a Blog is wrong in the one place a machine reads
  // this page, so the type and the property that carries the entries both
  // follow the feed's kind. The entries themselves are the same rows either
  // way — what differs is what they are called.
  // An article is not a blog post and a newsroom is not a Blog, so news gets
  // its own pair too. Everything else keeps the blog shape, which is what the
  // overwhelming majority of the directory is.
  const news = feed.category === 'news';
  const entryType = podcast ? 'PodcastEpisode' : news ? 'NewsArticle' : 'BlogPosting';
  const entryProp = podcast || news ? 'hasPart' : 'blogPost';

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': podcast ? 'PodcastSeries' : news ? 'NewsMediaOrganization' : 'Blog',
    name: feed.title,
    description: feed.description ?? undefined,
    url: feed.site_url ?? `${siteUrl()}/${feed.slug}`,
    webFeed: String(feed.feed_url),
    keywords: topics.length ? topics.map((t) => String(t.keyword)).join(', ') : undefined,
    [entryProp]: posts.slice(0, 20).map((p) => ({
      '@type': entryType,
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
        <a href={category.path}>{category.one[0].toUpperCase() + category.one.slice(1)}</a>
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
          {feed.item_count} {category.item}
        </span>
      </div>

      {/* Follow and share, side by side, because they are the two things to do
          with a feed you have just found and only one of them needs an
          account. */}
      <div className="detail-actions">
        {/* A plain form underneath, so following works with JavaScript off, and
            a click that lands flips the button in place rather than reloading
            fifty posts. A signed-out reader is not shown a dead button: the
            endpoint sends them to sign in and back here afterwards. */}
        <FollowButton
          endpoint="/api/follows"
          slug={String(feed.slug)}
          following={following}
          signedIn={Boolean(user)}
          next={`/${slug}`}
          label="Follow"
        />

        <Share
          url={pageUrl}
          title={String(feed.title)}
          text={shareText({ title: feed.title, summary: feed.description, url: pageUrl })}
          // Named by the feed's own category rather than by the podcast/not
          // split the button arrived with: this branch is the one that made
          // "blog" wrong for a newsroom, and the table already holds the word.
          textLabel={`Copy ${category.one}`}
        />
      </div>

      {/* What this feed writes about, and the way across to everyone else who
          writes about it. Sat under the follow button rather than up in the
          meta line: it is a second navigation surface, not a fact about the
          feed like its host or its post count. */}
      {topics.length > 0 && (
        <nav className="topic-chips" aria-label="Topics">
          {topics.map((t) => (
            <a
              key={String(t.slug)}
              href={`/topics/${encodeURIComponent(String(t.slug))}`}
              // The author's own tag is marked, because it is a different kind
              // of claim from a phrase we counted.
              className={t.source === 'category' ? 'tagged' : undefined}
              title={
                t.source === 'category'
                  ? 'Tagged by the author'
                  : `Appears in ${t.count} of this feed's posts`
              }
            >
              {t.keyword}
            </a>
          ))}
        </nav>
      )}

      {feed.status === 'dead' && (
        <p className="notice">
          This feed stopped responding, so we no longer crawl it. The archive below is what we
          collected while it was live.
        </p>
      )}

      <h2>Latest {category.item}</h2>

      {posts.length === 0 ? (
        <p className="empty">
          No {category.item} collected yet — the crawler will pick this up shortly.
        </p>
      ) : (
        posts.flatMap((p, i) => {
          // What the roaming player could carry, if anything: null for a post
          // with no enclosure, and for a YouTube or PeerTube one, which plays
          // only inside its own frame on its own page.
          const track = trackFor(p, { slug, feedTitle: String(feed.title) });
          const lanes = lanesOffered(p);

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

              {/* Queue it from the archive, rather than having to open every
                  episode to line one up. The play control is here for the same
                  reason: on a podcast's page, "play this one now" is the thing
                  a visitor came to do, and it now starts in a player that
                  survives them wandering off to the next blog. */}
              <div className="entry-actions">
                {track && (
                  <PlayButton
                    track={track}
                    lane={lanes[0]}
                    href={`/${slug}/read?p=${encodeURIComponent(String(p.guid))}`}
                  />
                )}

                <QueueButton
                  slug={slug}
                  guid={String(p.guid)}
                  lanes={lanes}
                  queued={queued[String(p.id)] ?? []}
                  next={`/${slug}`}
                  compact
                />
              </div>
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
