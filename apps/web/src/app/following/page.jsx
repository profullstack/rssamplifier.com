import { accounts } from '@rssamplifier/db';

import FollowingIntro from './FollowingIntro.jsx';
import { directoryIndex } from '../../lib/directory.js';
import Thumb from '../Thumb.jsx';
import Toolbar from '../Toolbar.jsx';
import ListFilter from '../ListFilter.jsx';
import { FILTER_FROM } from '../../lib/listFilter.js';
import { db, siteUrl } from '../../lib/db.js';
import { currentUser, hasSessionCookie } from '../../lib/auth.js';
import { postThumb } from '../../lib/thumbs.js';
import {
  RIVER_LIMIT,
  RIVER_AUTHORS,
  RIVER_TOPICS,
  following as loadFollowing,
  followingFeedUrl,
  topicLabel,
} from '../../lib/following.js';

export const dynamic = 'force-dynamic';

/**
 * How many real directory rows the signed-out page offers to follow.
 *
 * Enough to look like a directory rather than a teaser, few enough that the
 * page is still about the idea. The rows come from the same cached index the
 * home page uses, so showing them costs nothing extra.
 */
const INTRO_ROWS = 8;

/**
 * Two pages live at this URL, and they want opposite things from a crawler.
 *
 * Signed in it is one reader's river, assembled from their own follows: nothing
 * there belongs in an index, and the personal feed URL least of all. Signed out
 * it is a description of what following *is* — which is a page worth finding,
 * and the only version a crawler can ever reach, since a crawler has no
 * session.
 *
 * @returns {Promise<import('next').Metadata>}
 */
export async function generateMetadata() {
  // Presence, not identity: see hasSessionCookie. Resolving the session here
  // would double the lookup on every render of this page.
  if (await hasSessionCookie()) {
    return {
      title: 'Following',
      description: 'Everything you follow, newest first.',
      robots: { index: false, follow: false },
    };
  }

  return {
    title: 'Following',
    description:
      'Follow blogs, topics and people from the directory; everything they publish arrives in one river, with its own private RSS address.',
  };
}

/**
 * The river: everything this account follows, in one list.
 *
 * The point of the page is that the two kinds of follow stop being two kinds.
 * A followed blog and a followed topic are different questions to ask the
 * directory — "tell me when these people post" and "tell me when anybody posts
 * about this" — but they have the same answer shape, and a reader who has asked
 * both wants one list back rather than two pages to check.
 *
 * @param {{ searchParams: Promise<{ feed?: string, rotated?: string }> }} props
 */
export default async function FollowingPage({ searchParams }) {
  const params = await searchParams;
  const user = await currentUser();

  // Signed out, show what the feature is rather than a sign-in form for
  // something they have never seen. Reasoning in FollowingIntro.
  if (!user) {
    const { rows, total } = await directoryIndex();
    return <FollowingIntro rows={rows.slice(0, INTRO_ROWS)} total={total} />;
  }

  const client = db();
  const userId = String(user.id);

  const [{ feeds, topics, authors, items, topicsUsed, authorsUsed }, token] = await Promise.all([
    loadFollowing(client, userId, { limit: RIVER_LIMIT }),
    accounts.feedToken(client, userId),
  ]);

  const origin = siteUrl();
  const nothing = feeds.length === 0 && topics.length === 0 && authors.length === 0;

  return (
    <>
      <p className="eyebrow">Your river</p>
      <h1>Following</h1>

      {params.rotated && (
        <p className="notice">
          New feed URL below. The old one stopped working the moment this one was made, so any
          reader still holding it needs the new address.
        </p>
      )}

      {nothing ? (
        <p className="lede">
          Nothing followed yet. Press <strong>Follow</strong> on any <a href="/blogs">blog</a> to be
          told when they post, on any <a href="/topics">topic</a> to be told when anybody posts
          about it — <a href="/topics/ai">ai</a> and <a href="/topics/ai/podcasts">ai: podcasts</a>{' '}
          are two separate follows, because they are two separate pages — or on a{' '}
          <a href="/authors">person</a>, which collects everything they publish wherever they
          publish it.
        </p>
      ) : (
        <p className="lede">
          {describe(topics.length, 'topic')}, {describe(authors.length, 'person', 'people')} and{' '}
          {describe(feeds.length, 'blog')}, merged newest first.
        </p>
      )}

      {topics.length > 0 && (
        <>
          <h2>Topics</h2>

          {topics.length >= FILTER_FROM && (
            <ListFilter target=".following-topics > li" noun="topic" />
          )}

          <ul className="post-list following-list following-topics">
            {topics.map((t) => {
              const label = topicLabel(t);

              return (
                <li key={`${t.slug}:${t.segment}`}>
                  <a href={label.href}>{label.title}</a>
                  {/* Unfollowing lives next to the thing it undoes. The same
                      endpoint the topic page posts to, told explicitly which way
                      to go rather than toggling, so a double submit cannot
                      re-follow what it just removed. */}
                  <form className="follow-form" action="/api/follows/topics" method="post">
                    <input type="hidden" name="slug" value={String(t.slug)} />
                    {t.segment && <input type="hidden" name="segment" value={String(t.segment)} />}
                    <input type="hidden" name="action" value="unfollow" />
                    <button type="submit" className="secondary-button">
                      Unfollow
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>

          {/* Said out loud rather than left as a silent truncation: a reader
              following thirty topics and shown a river drawn from twelve of them
              would otherwise conclude the other eighteen had stopped
              publishing. */}
          {topics.length > topicsUsed && (
            <p className="hint">
              The river below is drawn from the {RIVER_TOPICS} topics you followed most recently.
              The rest are still followed — open any of them above for its own page and feed.
            </p>
          )}
        </>
      )}

      {authors.length > 0 && (
        <>
          <h2>People</h2>

          {authors.length >= FILTER_FROM && (
            <ListFilter target=".following-people > li" noun="person" />
          )}

          <ul className="post-list following-list following-people">
            {authors.map((a) => (
              <li key={String(a.slug)}>
                <a href={`/authors/${encodeURIComponent(String(a.slug))}`}>{String(a.name)}</a>
                {/* Unfollowing lives next to the thing it undoes, told explicitly
                    which way to go rather than toggling, so a double submit
                    cannot re-follow what it just removed. */}
                <form className="follow-form" action="/api/follows/authors" method="post">
                  <input type="hidden" name="slug" value={String(a.slug)} />
                  <input type="hidden" name="action" value="unfollow" />
                  <button type="submit" className="secondary-button">
                    Unfollow
                  </button>
                </form>
              </li>
            ))}
          </ul>

          {/* Said out loud rather than left as a silent truncation, for the same
              reason the topics section says it. */}
          {authors.length > authorsUsed && (
            <p className="hint">
              The river below is drawn from the {RIVER_AUTHORS} people you followed most recently.
              The rest are still followed — open any of them above for their own page and feed.
            </p>
          )}
        </>
      )}

      {feeds.length > 0 && (
        <>
          <h2>Blogs</h2>
          <div className="feed-meta detail">
            {feeds.map((f) => (
              <a key={String(f.slug)} href={`/${f.slug}`}>
                {String(f.title)}
              </a>
            ))}
          </div>
        </>
      )}

      <h2>Your feed</h2>
      <p className="hint">
        This river, as something to subscribe to. The URL carries an unguessable token instead of
        asking your reader to sign in: it grants read of these posts and nothing else — it cannot
        sign in, and it cannot change what you follow. Treat it as private anyway, because it says
        what you read.
      </p>

      {token ? (
        <>
          <p className="format-links">
            <span>Subscribe:</span>
            {['rss', 'atom', 'json'].map((ext) => (
              <a key={ext} href={followingFeedUrl(origin, token, ext)}>
                {`.${ext}`}
              </a>
            ))}
          </p>
          <p className="hint">
            <code>{followingFeedUrl(origin, token, 'rss')}</code>
          </p>
          <form action="/api/following/token" method="post" className="submit-actions">
            <input type="hidden" name="action" value="rotate" />
            <button type="submit" className="secondary-button">
              Rotate this URL
            </button>
          </form>
        </>
      ) : (
        <form action="/api/following/token" method="post" className="submit-actions">
          <input type="hidden" name="action" value="create" />
          <button type="submit">Create my feed URL</button>
        </form>
      )}

      <h2>Latest</h2>

      {/* The river is the reason to come back to this page, and it is the one
          list here long enough that finding a post in it means scrolling. */}
      {items.length >= FILTER_FROM && (
        <ListFilter target="article.entry" noun="post" searchHref="/search?q=" />
      )}

      {items.length === 0 ? (
        <p className="empty">
          {nothing
            ? 'Nothing to show until you follow something.'
            : 'Nothing published recently by anything you follow.'}
        </p>
      ) : (
        items.map((p) => {
          // A mixed river reads better with pictures in it than without, and a
          // post with none of its own borrows its feed's cover art — which the
          // query selects as feed_image for exactly this.
          const thumb = postThumb(p);
          const readHref = `/${p.feed_slug}/read?p=${encodeURIComponent(String(p.guid))}`;

          return (
          <article
            className={thumb ? 'entry has-thumb' : 'entry'}
            key={`${p.feed_slug}-${p.guid}`}
          >
            <Thumb src={thumb} href={readHref} />

            <h3>
              <a href={readHref}>{String(p.title)}</a>
            </h3>
            {p.summary && <p>{String(p.summary)}</p>}
            <p className="meta">
              <a href={`/${p.feed_slug}`}>{String(p.feed_title)}</a>
              {p.published_at ? ` · ${formatDate(p.published_at)}` : ''}
              {/* Why this post is here. Only for the topic follows: a post from a
                  followed blog is already explained by the blog's own name, and
                  "via Blog Name" beside "Blog Name" is noise. */}
              {p.via?.kind === 'topic' && (
                <>
                  {' · via '}
                  <a href={String(p.via.href)}>{String(p.via.title)}</a>
                </>
              )}
              {p.duplicates > 0 && ` · also in ${p.duplicates} other feed${
                p.duplicates === 1 ? '' : 's'
              }`}
            </p>
          </article>
          );
        })
      )}

      <Toolbar />
    </>
  );
}

/**
 * "3 topics", "one blog", "no people".
 *
 * The plural is a parameter rather than an `s` because one of the three nouns
 * here does not take one: "3 persons" is not what anybody says.
 *
 * @param {number} n
 * @param {string} noun
 * @param {string} [plural]
 * @returns {string}
 */
function describe(n, noun, plural = `${noun}s`) {
  if (n === 0) return `no ${plural}`;
  if (n === 1) return `one ${noun}`;
  return `${n} ${plural}`;
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
