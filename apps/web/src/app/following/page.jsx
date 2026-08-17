import { redirect } from 'next/navigation';
import { accounts } from '@rssamplifier/db';

import Toolbar from '../Toolbar.jsx';
import { db, siteUrl } from '../../lib/db.js';
import { currentUser } from '../../lib/auth.js';
import {
  RIVER_LIMIT,
  RIVER_TOPICS,
  following as loadFollowing,
  followingFeedUrl,
  topicLabel,
} from '../../lib/following.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Following',
  description: 'Everything you follow, newest first.',
  // One reader's river, assembled from their own follows. Nothing here belongs
  // in an index, and the personal feed URL below least of all.
  robots: { index: false, follow: false },
};

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
  if (!user) redirect('/login?next=%2Ffollowing');

  const client = db();
  const userId = String(user.id);

  const [{ feeds, topics, items, topicsUsed }, token] = await Promise.all([
    loadFollowing(client, userId, { limit: RIVER_LIMIT }),
    accounts.feedToken(client, userId),
  ]);

  const origin = siteUrl();
  const nothing = feeds.length === 0 && topics.length === 0;

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
          told when they post, or on any <a href="/topics">topic</a> to be told when anybody posts
          about it — <a href="/topics/ai">ai</a> and <a href="/topics/ai/podcasts">ai: podcasts</a>{' '}
          are two separate follows, because they are two separate pages.
        </p>
      ) : (
        <p className="lede">
          {describe(topics.length, 'topic')} and {describe(feeds.length, 'blog')}, merged newest
          first.
        </p>
      )}

      {topics.length > 0 && (
        <>
          <h2>Topics</h2>
          <ul className="post-list following-list">
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

      {items.length === 0 ? (
        <p className="empty">
          {nothing
            ? 'Nothing to show until you follow something.'
            : 'Nothing published recently by anything you follow.'}
        </p>
      ) : (
        items.map((p) => (
          <article className="entry" key={`${p.feed_slug}-${p.guid}`}>
            <h3>
              <a href={`/${p.feed_slug}/read?p=${encodeURIComponent(String(p.guid))}`}>
                {String(p.title)}
              </a>
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
        ))
      )}

      <Toolbar />
    </>
  );
}

/**
 * "3 topics", "one blog", "no topics".
 *
 * @param {number} n
 * @param {string} noun
 * @returns {string}
 */
function describe(n, noun) {
  if (n === 0) return `no ${noun}s`;
  if (n === 1) return `one ${noun}`;
  return `${n} ${noun}s`;
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
