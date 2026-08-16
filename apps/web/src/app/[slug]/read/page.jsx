import { notFound } from 'next/navigation';
import { q, reactions } from '@rssamplifier/db';
import { isFrameable } from '@rssamplifier/feed';

import { db, siteUrl } from '../../../lib/db.js';
import { currentUser } from '../../../lib/auth.js';
import { AD_MREC } from '../../../lib/ads.js';
import Ad from '../../Ad.jsx';
import Comments from '../../Comments.jsx';
import PostActions from '../../PostActions.jsx';
import ReaderToolbar from '../../ReaderToolbar.jsx';

export const dynamic = 'force-dynamic';

/**
 * @param {{ params: Promise<{ slug: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { slug } = await params;
  const feed = await q.feedBySlug(db(), slug);
  return {
    title: feed ? `Reading · ${feed.title}` : 'Not found',
    // The reader is a view of someone else's page; it should never compete with
    // the original in search results.
    robots: { index: false, follow: true },
  };
}

/**
 * Read one post without leaving the directory.
 *
 * Kagi's Small Web keeps its bar on screen while you read by framing the page,
 * and that is what makes browsing feel like one place rather than a list of
 * outbound links. This does the same: the post is framed, the roaming toolbar
 * stays put, and moving through a blog's archive never costs a round trip
 * through an index.
 *
 * Not every site permits it — plenty send X-Frame-Options or a frame-ancestors
 * policy — and a browser gives the embedder no way to detect that from the
 * outside. So the policy is checked server-side first and a refusal renders an
 * honest card rather than a blank rectangle.
 *
 * @param {{ params: Promise<{ slug: string }>, searchParams: Promise<{ p?: string }> }} props
 */
export default async function ReaderPage({ params, searchParams }) {
  const { slug } = await params;
  const { p: guid } = await searchParams;

  const client = db();
  const feed = await q.feedBySlug(client, slug);
  if (!feed) notFound();

  const feedId = String(feed.id);

  // The post list doubles as the reader's running order, so newer/older are
  // just neighbours in the same query the blog page already makes.
  const posts = await q.itemsForFeed(client, feedId, 200);
  const index = guid ? posts.findIndex((item) => String(item.guid) === guid) : 0;

  // That window is a running order, not the archive: a fifth of all the posts
  // we hold sit outside their own feed's newest 200. Search reaches them, so
  // the reader has to as well — fall back to fetching the one post by guid and
  // simply do without neighbours, rather than claiming it does not exist.
  const inOrder = index >= 0 && posts[index] !== undefined;
  const post = inOrder ? posts[index] : guid ? await q.itemByGuid(client, feedId, guid) : null;

  if (!post) notFound();

  const postUrl = post.url ? String(post.url) : null;
  const verdict = postUrl
    ? await isFrameable(postUrl, siteUrl())
    : { frameable: false, reason: 'no-url' };

  const nav = await q.neighbours(client, String(feed.created_at));

  // Reactions hang off the item id, which never leaves the server: the page and
  // the API both address a post as (slug, guid).
  const itemId = String(post.id);
  const user = await currentUser();
  const userId = user ? String(user.id) : null;

  const [score, mine, thread] = await Promise.all([
    reactions.scoreFor(client, itemId),
    userId ? reactions.reactionFor(client, userId, itemId) : { liked: false, vote: 0 },
    reactions.commentsFor(client, itemId),
  ]);

  return (
    <div className="reader">
      <div className="reader-head">
        <p className="eyebrow">
          <a href={`/${slug}`}>{String(feed.title)}</a>
          {post.published_at ? ` · ${formatDate(post.published_at)}` : ''}
        </p>
        <h1>{String(post.title)}</h1>

        <PostActions
          slug={slug}
          guid={String(post.guid)}
          score={score.score}
          liked={mine.liked}
          vote={mine.vote}
          signedIn={Boolean(userId)}
        />
      </div>

      {verdict.frameable && postUrl ? (
        <iframe
          className="reader-frame"
          src={postUrl}
          title={String(post.title)}
          // The framed page is a stranger's: allow it to render and navigate
          // itself, and nothing else. No same-origin, so it can never reach
          // into this document.
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
          referrerPolicy="no-referrer-when-downgrade"
          loading="eager"
        />
      ) : (
        <div className="reader-fallback">
          <p className="notice">
            {explain(verdict.reason)} You can still read it on the original site — the toolbar
            below keeps your place in the directory.
          </p>

          {post.summary && <p className="lede">{String(post.summary)}</p>}

          {postUrl && (
            <p>
              <a className="button" href={postUrl} target="_blank" rel="noopener">
                Read on {hostOf(postUrl)} ↗
              </a>
            </p>
          )}

          {/*
           * The only advertising in the reader, and only on this branch.
           *
           * When the frame loads, everything on screen is somebody else's
           * article and the money an ad made here would be made off their
           * writing. That is the same reason this page is already noindex —
           * it must not compete with the original — and selling space around
           * it would be the same trespass with a bill attached.
           *
           * This branch is different: nothing was framed, so the page is our
           * own summary and our own link out, and it can carry a unit.
           */}
          <Ad format={AD_MREC} />
        </div>
      )}

      <Comments slug={slug} guid={String(post.guid)} comments={thread} userId={userId} />

      <ReaderToolbar
        slug={slug}
        feedTitle={String(feed.title)}
        postUrl={postUrl}
        prevGuid={inOrder && index > 0 ? String(posts[index - 1].guid) : null}
        nextGuid={inOrder && index < posts.length - 1 ? String(posts[index + 1].guid) : null}
        nextBlog={nav.next}
      />
    </div>
  );
}

/**
 * Say why a page could not be framed, in words a reader can act on.
 *
 * @param {string} reason
 * @returns {string}
 */
function explain(reason) {
  if (reason.startsWith('x-frame-options') || reason === 'csp-frame-ancestors') {
    return 'This site does not allow itself to be embedded.';
  }
  if (reason === 'timeout') return 'This site took too long to answer.';
  if (reason.startsWith('http-')) return 'This page did not load.';
  return 'This page cannot be shown here.';
}

/**
 * @param {unknown} iso
 * @returns {string}
 */
function formatDate(iso) {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return '';
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
