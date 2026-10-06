import { notFound, permanentRedirect } from 'next/navigation';
import { sanitizeHtml } from '@rssamplifier/feed';
import { redditPostId, redditSource } from '@rssamplifier/social';

import { loadRedditThread, threadSlug } from '../../../../../../lib/redditThread.js';
import RedditComments, { when } from '../../../../RedditComments.jsx';

export const dynamic = 'force-dynamic';

/**
 * A Reddit thread at the address Reddit gives it, on our host.
 *
 * `/r/AskTechnology/comments/1wuoyvc/what_are_the_best/` is what people copy out
 * of Reddit, so swapping the host for rssamp.com or rssamplifier.com is all it
 * takes to read the post and every reply without Reddit's app wall. The slug is
 * decoration, as it is on Reddit: any slug, or none, finds the thread.
 *
 * Read live from Arctic Shift and never stored (see `lib/redditThread.js`).
 * The canonical URL is Reddit's own and the page is not indexed: this is a
 * reading copy of somebody else's conversation, not a page of ours to rank.
 *
 * @param {{ params: Promise<{ subreddit: string, id: string, slug?: string[] }> }} props
 */
export async function generateMetadata({ params }) {
  const { subreddit, id } = await params;
  const thread = await safeLoad(subreddit, id);
  const post = thread?.post ?? thread?.moved;
  if (!post) return { title: 'Thread not found', robots: { index: false, follow: false } };

  return {
    title: `${post.title} : r/${post.subreddit}`,
    description: `${post.numComments} comments on r/${post.subreddit}, mirrored by RSS Amplifier.`,
    alternates: { canonical: post.redditUrl },
    robots: { index: false, follow: true },
  };
}

/**
 * @param {{ params: Promise<{ subreddit: string, id: string, slug?: string[] }> }} props
 */
export default async function RedditThreadPage({ params }) {
  const { subreddit, id } = await params;
  if (!redditSource(`r/${subreddit}`) || !redditPostId(id)) notFound();

  const thread = await safeLoad(subreddit, id);

  if (thread?.error) {
    return (
      <div className="reader">
        <div className="reader-head">
          <p className="eyebrow">
            <a href={`/r/${subreddit}`}>r/{subreddit}</a>
          </p>
          <h1>The Reddit archive did not answer</h1>
        </div>
        <p className="lede">
          This thread is read live from Arctic Shift, and it is slow or down right now. Try again in a
          minute, or{' '}
          <a href={`https://www.reddit.com/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(id)}/`}>
            open it on Reddit
          </a>
          .
        </p>
      </div>
    );
  }

  if (!thread) notFound();

  // The id is the thread; the subreddit in the URL is only a claim about it.
  if (thread.moved) {
    permanentRedirect(`/r/${thread.moved.subreddit}/comments/${thread.moved.id}/${threadSlug(thread.moved.title)}`);
  }

  const { post, comments } = thread;
  const shown = countComments(comments);

  return (
    <div className="reader reddit-thread">
      <div className="reader-head">
        <p className="eyebrow">
          <a href={`/r/${post.subreddit}`}>r/{post.subreddit}</a>
          {post.createdAt ? ` · ${when(post.createdAt)}` : ''}
          {post.removed ? '' : ' · '}
          {!post.removed && (
            <a href={`https://www.reddit.com/user/${encodeURIComponent(post.author)}`} rel="nofollow noopener">
              u/{post.author}
            </a>
          )}
        </p>
        <h1>{post.title}</h1>
        {post.flair && <p className="topic-chips">{post.flair}</p>}
      </div>

      {post.removed ? (
        <p className="notice">This post was removed on Reddit. The replies below are what is left of the thread.</p>
      ) : (
        <>
          {post.link && (
            <p className="lede">
              <a href={post.link} rel="nofollow noopener" target="_blank">
                {post.domain || post.link} ↗
              </a>
            </p>
          )}
          {post.html && <article className="reader-article" dangerouslySetInnerHTML={{ __html: sanitizeHtml(post.html) }} />}
        </>
      )}

      <p className="hint">
        <a href={post.redditUrl} target="_blank" rel="noopener">
          Reply on Reddit ↗
        </a>
        {post.score !== null ? ` · ${post.score} point${Math.abs(post.score) === 1 ? '' : 's'}` : ''}
      </p>

      <section className="comments" id="comments">
        <h2>
          {shown === 0 ? 'No comments yet' : `${shown} comment${shown === 1 ? '' : 's'}`}
          {post.numComments > shown ? ` (of ${post.numComments} on Reddit)` : ''}
        </h2>
        <RedditComments comments={comments} op={post.author} />
      </section>

    </div>
  );
}

/** A thrown archive error becomes `{ error }`, so the page can say so rather than 500. */
async function safeLoad(subreddit, id) {
  try {
    return await loadRedditThread(subreddit, id);
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

function countComments(comments) {
  return comments.reduce((n, c) => n + (c.removed ? 0 : 1) + countComments(c.replies), 0);
}
