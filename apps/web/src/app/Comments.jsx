/**
 * The conversation on a post.
 *
 * These comments live here, not on the author's site: the reader is a view of
 * somebody else's article and nothing typed in this box is ever sent to them.
 *
 * @param {{
 *   slug: string,
 *   guid: string,
 *   comments: object[],
 *   userId: string|null,
 * }} props
 */
export default function Comments({ slug, guid, comments, userId }) {
  const live = comments.filter((c) => !c.deleted_at);

  return (
    <section className="comments" id="comments">
      <h2>
        {live.length === 0
          ? 'Comments'
          : `${live.length} comment${live.length === 1 ? '' : 's'}`}
      </h2>

      {comments.length === 0 && <p className="meta">Nothing yet. Say the first thing.</p>}

      <ol className="comment-list">
        {comments.map((comment) => {
          const id = String(comment.id);
          const mine = userId !== null && String(comment.user_id) === userId;
          const removed = Boolean(comment.deleted_at);

          return (
            <li key={id} id={`comment-${id}`} className={removed ? 'comment removed' : 'comment'}>
              <p className="comment-meta">
                <strong>{displayName(comment.email)}</strong>
                <time dateTime={String(comment.created_at)}>{when(comment.created_at)}</time>
              </p>

              {removed ? (
                <p className="comment-body">
                  <em>Withdrawn by its author.</em>
                </p>
              ) : (
                // Feed content is never trusted as markup anywhere in this app,
                // and a comment is even less trustworthy. Rendered as text.
                <p className="comment-body">{String(comment.body)}</p>
              )}

              {mine && !removed && (
                <form method="post" action="/api/comments" className="inline-form">
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="guid" value={guid} />
                  <input type="hidden" name="action" value="delete" />
                  <input type="hidden" name="id" value={id} />
                  <button type="submit" className="linkish">
                    Delete
                  </button>
                </form>
              )}
            </li>
          );
        })}
      </ol>

      {userId ? (
        <form method="post" action="/api/comments" className="comment-form">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="guid" value={guid} />
          <label htmlFor="comment-body">Add a comment</label>
          <textarea
            id="comment-body"
            name="body"
            rows={4}
            maxLength={4000}
            placeholder="What did you make of it?"
            required
          />
          <button type="submit" className="button">
            Post comment
          </button>
        </form>
      ) : (
        <p className="meta">
          <a href={`/login?next=${encodeURIComponent(`/${slug}/read?p=${guid}`)}`}>Sign in</a> to
          join the conversation.
        </p>
      )}
    </section>
  );
}

/**
 * A name to show a commenter by.
 *
 * The only thing an account carries is an email address, and publishing one in
 * full next to a comment is handing out a working address to every scraper that
 * reads this page. The local part alone identifies the person to anyone who
 * knows them and is not deliverable on its own.
 *
 * @param {unknown} email
 * @returns {string}
 */
function displayName(email) {
  const at = String(email ?? '').indexOf('@');
  const local = at > 0 ? String(email).slice(0, at) : String(email ?? '');
  return local || 'someone';
}

/**
 * @param {unknown} iso
 * @returns {string}
 */
function when(iso) {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
