import Share from './Share.jsx';

/**
 * Like, upvote, downvote and share for one post.
 *
 * Plain forms posting to /api/reactions, like every other control on the site:
 * no client bundle, works with JavaScript off, and the 303 back to the reader
 * means the browser's own history stays sane.
 *
 * A like and a vote say different things and are kept apart on purpose. The
 * like is private — it puts the post on the reader's own shelf at /favorites —
 * while the votes are public and move a score everybody sees. Saving something
 * to read again should not require endorsing it.
 *
 * Share sits in the same row and is the one control here that asks nothing of
 * the reader: no account, no vote, and it is the only thing on the page that
 * hands the post to somebody who is not already here.
 *
 * @param {{
 *   slug: string,
 *   guid: string,
 *   score: number,
 *   liked: boolean,
 *   vote: number,
 *   signedIn: boolean,
 *   shareUrl: string,
 *   shareTitle: string,
 *   shareText: string,
 * }} props
 */
export default function PostActions({
  slug,
  guid,
  score,
  liked,
  vote,
  signedIn,
  shareUrl,
  shareTitle,
  shareText,
}) {
  return (
    <div className="post-actions">
      <Action
        slug={slug}
        guid={guid}
        action="up"
        className={`vote up${vote === 1 ? ' on' : ''}`}
        label="Upvote"
        // aria-pressed tells a screen reader the button is a toggle in a state,
        // which is the whole meaning of a vote control.
        pressed={vote === 1}
      >
        <span aria-hidden="true">▲</span>
      </Action>

      <span className={`score${score > 0 ? ' positive' : score < 0 ? ' negative' : ''}`}>
        {score > 0 ? `+${score}` : String(score)}
      </span>

      <Action
        slug={slug}
        guid={guid}
        action="down"
        className={`vote down${vote === -1 ? ' on' : ''}`}
        label="Downvote"
        pressed={vote === -1}
      >
        <span aria-hidden="true">▼</span>
      </Action>

      <span className="sep" aria-hidden="true" />

      <Action
        slug={slug}
        guid={guid}
        action={liked ? 'unlike' : 'like'}
        className={`like${liked ? ' on' : ''}`}
        label={liked ? 'Remove from favorites' : 'Save to favorites'}
        pressed={liked}
      >
        <span aria-hidden="true">{liked ? '♥' : '♡'}</span>
        <span className="label">{liked ? 'Favorited' : 'Like'}</span>
      </Action>

      <Share url={shareUrl} title={shareTitle} text={shareText} textLabel="Copy post" />

      {!signedIn && (
        <span className="hint">
          <a href={`/login?next=${encodeURIComponent(`/${slug}/read?p=${guid}`)}`}>Sign in</a> to
          vote or save
        </span>
      )}
    </div>
  );
}

/**
 * One button, as its own form.
 *
 * @param {{
 *   slug: string,
 *   guid: string,
 *   action: string,
 *   className: string,
 *   label: string,
 *   pressed: boolean,
 *   children: React.ReactNode,
 * }} props
 */
function Action({ slug, guid, action, className, label, pressed, children }) {
  return (
    <form method="post" action="/api/reactions" className="inline-form">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="guid" value={guid} />
      <input type="hidden" name="action" value={action} />
      <button type="submit" className={className} title={label} aria-label={label} aria-pressed={pressed}>
        {children}
      </button>
    </form>
  );
}
