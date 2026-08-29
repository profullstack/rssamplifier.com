import { notFound } from 'next/navigation';
import { q, alerts, queue, authors as people } from '@rssamplifier/db';

import { db, siteUrl } from '../../lib/db.js';
import { currentUser } from '../../lib/auth.js';
import { feedAdPlan } from '../../lib/feedAdPlan.js';
import {
  FEED_QUEUE_LIMIT,
  alreadyQueued,
  entryLanes,
  lanesOffered,
  playableEntries,
  trackFor,
} from '../../lib/queue.js';
import { shareText } from '../../lib/share.js';
import { feedCard, postThumb } from '../../lib/thumbs.js';
import { feedAlternates } from '../../lib/subscribe.js';
import Ad from '../Ad.jsx';
import AdBanner from '../AdBanner.jsx';
import AuthorLinks from '../AuthorLinks.jsx';
import FollowControls from '../FollowControls.jsx';
import ListFilter from '../ListFilter.jsx';
import { FILTER_FROM } from '../../lib/listFilter.js';
import Freshness from '../Freshness.jsx';
import PlayButton from '../PlayButton.jsx';
import QueueAll from '../QueueAll.jsx';
import QueueButton from '../QueueButton.jsx';
import Share from '../Share.jsx';
import SubscribeLinks from '../SubscribeLinks.jsx';
import Thumb from '../Thumb.jsx';
import Toolbar from '../Toolbar.jsx';
import { CATEGORIES } from '../CategoryIndex.jsx';
import { jsonLdScript } from '../../lib/jsonld.js';

export const dynamic = 'force-dynamic';

/**
 * @param {{ params: Promise<{ slug: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { slug } = await params;
  const feed = await q.feedBySlug(db(), slug);
  if (!feed) return { title: 'Not found' };

  const title = String(feed.title);
  const description = feed.description
    ? String(feed.description)
    : `Latest ${(CATEGORIES[String(feed.category)] ?? CATEGORIES.blog).item} from ${feed.title}.`;

  // The publisher's own picture as the shared card, where the crawler has been
  // and measured one big enough to survive a social-media crop. Where it has
  // not, this stays undefined and the site's generated card in
  // opengraph-image.jsx applies — which is the better answer than promising a
  // favicon, and the reason this page had no card of its own until the crawler
  // learned to check.
  const card = feedCard(feed);
  const url = `${siteUrl()}/${slug}`;

  return {
    title,
    description,
    // Our copy of this feed, at our address, announced the way every feed
    // reader and browser extension looks for one. Before this the page had no
    // rel="alternate" at all and autodiscovery found nothing — the one link
    // offered pointed at the publisher's own URL, which is a strange thing for
    // a directory to hand out: the reader subscribes somewhere else and none of
    // the work this site did (cleaned summaries, credited authors, the reader)
    // goes with them. The publisher's original is still on the page, one line
    // down and labelled as theirs.
    alternates: { canonical: url, types: feedAlternates(url, title) },

    // Spread rather than set to undefined, and this is not a style choice: a key
    // that is *present* and undefined is read by Next as "this page has no
    // openGraph", which clears the card the layout's opengraph-image.jsx would
    // otherwise supply. Written the obvious way, a feed with no picture of its
    // own ended up with no card at all — worse than the generated one it had
    // before anybody thought about cards.
    ...(card
      ? {
          // Restated in full rather than added to: a page's openGraph block
          // replaces the layout's rather than merging into it, so naming an
          // image here would otherwise drop the site name and the type too.
          openGraph: {
            type: 'website',
            siteName: 'RSS Amplifier',
            url,
            title,
            description,
            images: [{ url: card.url, width: card.width, height: card.height }],
          },

          // The dimensions decide the shape, not whether to have one: under the
          // large card's minimum, a wide card renders as a stretched mess, and
          // the small one is what the picture is actually the right size for.
          twitter: {
            card: card.large ? 'summary_large_image' : 'summary',
            title,
            description,
            images: [card.url],
          },
        }
      : {}),
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

  const [posts, nav, topics, credited, feedLinks, user] = await Promise.all([
    q.itemsForFeed(client, String(feed.id), FEED_QUEUE_LIMIT),
    q.neighbours(client, String(feed.created_at)),
    q.keywordsForFeed(client, String(feed.id)),
    people.authorsForFeed(client, String(feed.id)),
    people.linksForFeed(client, String(feed.id)),
    currentUser(),
  ]);

  // Only asked once we know there is someone to ask about.
  const [follow, queued] = user
    ? await Promise.all([
        // Following and alerting in one row, because the two controls sit side
        // by side and asking twice would be two queries for one answer.
        alerts.feedFollowState(client, String(user.id), String(feed.id)),
        // One statement for the whole page. Asking per post would be fifty
        // round trips to decide what fifty buttons say.
        queue.lanesForItems(
          client,
          String(user.id),
          posts.map((p) => String(p.id)),
        ),
      ])
    : [
        { following: false, alerts: false },
        /** @type {Record<string, ('read'|'listen'|'watch')[]>} */ ({}),
      ];

  // What "queue all" would act on, worked out from the posts already in hand
  // rather than asked for separately. The endpoint runs this same function over
  // this same query when the form comes back, which is what stops the number on
  // the button and the rows it adds from ever being two different sets.
  const playable = playableEntries(posts);

  // A blog page is the longest read on the site — up to fifty summaries — so it
  // is the one place a rectangle earns its keep, sat in the flow where somebody
  // has already stopped to read. At most three across fifty posts, alternating
  // so it never becomes a column of boxes, and none at all on a blog with only
  // a handful of entries.
  //
  // One in ten, which is not merely the same number the syndicated documents
  // use but the same function: feedAdPlan asks @rssamplifier/feed's adPositions
  // where the ads go, so /phoenix-fm and /phoenix-fm.rss place them after the
  // same posts. Restating the cadence here is what let the two drift before —
  // it was one in twelve starting at the fourth post, and a reader who meets an
  // ad after four posts on the page and after ten in the feed is being told two
  // different things about how heavily this site advertises.
  const ads = feedAdPlan(posts.length);

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
    // The people, with the accounts they published, in the vocabulary the
    // extractor read them out of. A feed page that names its author only in
    // prose is a page every other crawler has to guess at.
    author: credited.length
      ? credited.map((person) => ({
          '@type': 'Person',
          name: person.name,
          url: `${siteUrl()}/authors/${person.slug}`,
          sameAs: (person.links ?? [])
            .filter((l) => l.network !== 'email')
            .map((l) => l.url),
        }))
      : undefined,
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
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
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
        {/* The publisher's own feed, named as theirs and pointed at plainly.
            It is no longer the page's subscribe link — that is ours, below —
            but a directory that hides where a feed came from is a worse
            directory, and somebody who wants to go straight to the source
            should not have to view-source to find it. */}
        <a href={String(feed.feed_url)} rel="noopener">
          Source feed ↗
        </a>
        <span>
          {feed.item_count} {category.item}
        </span>
      </div>

      {/* Subscribe here, to us. The same posts, our summaries, and links that
          come back to the reader on this site rather than leaving it. `.md` is
          in the row because half of what reads this directory is not a person. */}
      <SubscribeLinks
        base={`/${slug}`}
        what={`this ${category.one}`}
        formats={podcast || feed.category === 'music' ? ['rss', 'atom', 'json', 'md', 'm3u', 'pls'] : undefined}
      />

      {/* How current this page is, and whether the feed behind it is still
          publishing — two different questions, both answered, always. See
          lib/freshness.js. The newest post's date comes off the list this page
          has already loaded, so the signal costs no extra query. */}
      <Freshness feed={feed} newestPost={posts[0]?.published_at ?? null} />

      {/* Follow and share, side by side, because they are the two things to do
          with a feed you have just found and only one of them needs an
          account. */}
      <div className="detail-actions">
        {/* A plain form underneath, so following works with JavaScript off, and
            a click that lands flips the button in place rather than reloading
            fifty posts. A signed-out reader is not shown a dead button: the
            endpoint sends them to sign in and back here afterwards. */}
        <FollowControls
          endpoint="/api/follows"
          kind="feed"
          slug={String(feed.slug)}
          following={follow.following}
          alerts={follow.alerts}
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

      {/* Who writes this, and where else they are. Under the topics rather
          than up in the meta line for the same reason topics are: it is a way
          out of this page to somewhere else, not a fact about the feed.

          The links are shown inline for a feed with one author — which is most
          of the small web, and where "how do I reach this person" is a question
          with a single answer. A group blog gets names only, because a row of
          six link sets is a wall, and each name leads to a page that has
          them. */}
      {credited.length > 0 && (
        <section className="feed-authors">
          <h2>Written by</h2>
          <ul>
            {credited.map((person) => (
              <li key={String(person.id)}>
                <a href={`/authors/${encodeURIComponent(String(person.slug))}`}>{person.name}</a>
                {credited.length === 1 && <AuthorLinks links={person.links} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The blog's own accounts. Shown when nobody is named — which is a
          third of the small web, and where they are the only way to reach
          whoever writes it — and for a group blog, where they belong to the
          publication rather than to any one of the bylines.

          Suppressed for a single-author feed, because there the same links are
          already sitting under that person's name and saying them twice adds
          nothing but a second row of chips. */}
      {feedLinks.length > 0 && !(credited.length === 1) && (
        <section className="feed-authors">
          <h2>{credited.length > 1 ? 'This blog elsewhere' : 'Elsewhere'}</h2>
          <AuthorLinks links={feedLinks} />
        </section>
      )}

      {feed.status === 'dead' && (
        <p className="notice">
          This feed stopped responding, so we no longer crawl it. The archive below is what we
          collected while it was live.
        </p>
      )}

      <h2>Latest {category.item}</h2>

      {/* Above the list, on the same reasoning the topic player uses: somebody
          who has decided to keep the whole show has decided that on the
          strength of the blurb, and should not have to scroll fifty rows to act
          on it. Renders nothing at all when the feed carries no files, which is
          every blog — QueueAll returns null on a total of zero. */}
      <QueueAll
        feed={slug}
        total={playable.length}
        queued={alreadyQueued(playable, queued)}
        lanes={entryLanes(playable)}
        next={`/${slug}`}
      />

      {/* An archive page can carry a hundred entries, and looking for one you
          half-remember the title of is the commonest thing to do with it. */}
      {posts.length >= FILTER_FROM && (
        <ListFilter
          target="article.entry"
          noun={category.item.replace(/s$/, '')}
          plural={category.item}
          searchHref="/search?q="
        />
      )}

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

          // The post's own picture, or the feed's cover art where it has none —
          // on one feed's page every row shares that fallback, so an archive
          // either has pictures throughout or has none, and never looks
          // half-finished.
          const thumb = postThumb(p, feed);
          const readHref = `/${slug}/read?p=${encodeURIComponent(String(p.guid))}`;

          const entry = (
            <article className={thumb ? 'entry has-thumb' : 'entry'} key={String(p.guid)}>
              <Thumb src={thumb} href={p.url ? readHref : null} />

              <h3>
                {p.url ? (
                  // Into the reader rather than straight out: the toolbar stays
                  // on screen, and the reader falls back to the original site for
                  // anything that refuses to be framed.
                  <a href={readHref}>{p.title}</a>
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
                    href={readHref}
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
        feedUrl={`/${slug}.rss`}
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
