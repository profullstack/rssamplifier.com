import { sanitizeHtml } from '@rssamplifier/feed';

/**
 * A Reddit comment tree, read-only.
 *
 * Kept apart from `Comments.jsx`, which is our own comments with delete and
 * reply forms; these belong to Reddit and nobody here can act on them. The
 * classes are shared so both look like one site. Bodies are Reddit markdown
 * already turned into a small HTML subset by `redditMarkdown`, and go through
 * the same allowlist as every feed body before they reach the page.
 *
 * @param {{ comments: import('@rssamplifier/social').RedditComment[], op?: string }} props
 */
export default function RedditComments({ comments, op }) {
  if (!comments.length) return null;
  return (
    <ol className="comment-list reddit-comments">
      {comments.map((comment) => (
        <RedditComment key={comment.id} comment={comment} op={op} />
      ))}
    </ol>
  );
}

function RedditComment({ comment, op }) {
  return (
    <li id={`t1_${comment.id}`} className={comment.removed ? 'comment removed' : 'comment'}>
      <p className="comment-meta">
        {comment.removed ? (
          <strong>[deleted]</strong>
        ) : (
          <a href={`https://www.reddit.com/user/${encodeURIComponent(comment.author)}`} rel="nofollow noopener">
            <strong>u/{comment.author}</strong>
          </a>
        )}
        {(comment.submitter || (op && comment.author === op)) && !comment.removed && <span className="op-badge">OP</span>}
        {comment.score !== null && <span>{comment.score} point{Math.abs(comment.score) === 1 ? '' : 's'}</span>}
        {comment.createdAt && <time dateTime={comment.createdAt}>{when(comment.createdAt)}</time>}
      </p>

      {comment.removed ? (
        <p className="comment-body">
          <em>Removed on Reddit.</em>
        </p>
      ) : (
        <div className="comment-body reddit-body" dangerouslySetInnerHTML={{ __html: sanitizeHtml(comment.html) }} />
      )}

      {comment.replies.length > 0 && <RedditComments comments={comment.replies} op={op} />}
    </li>
  );
}

/** @param {string} iso */
export function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
