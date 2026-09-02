import { Avatar } from '../Thumb.jsx';
import FollowButton from '../FollowButton.jsx';
import { feedImage } from '../../lib/thumbs.js';

/**
 * What /following is, shown to somebody who has not signed in.
 *
 * This page used to answer a signed-out visitor with `redirect('/login')`: a
 * sign-in form for a feature they had never seen, which asks them to value
 * something they have no way to evaluate. Nobody signs up for that. So the page
 * now renders, and the sign-in is asked for at the point of *use* rather than
 * at the point of arrival.
 *
 * The rows below are real feeds from the live directory, not a mockup, and
 * their Follow buttons are the same component the feed pages use. Pressing one
 * while signed out does what it has always done — posts the plain form, which
 * the endpoint answers with a redirect to /login and back again. That is the
 * whole design: the control is visible and it works, and what it costs is an
 * account rather than a locked door.
 *
 * @param {{ rows: object[], total: number }} props
 */
export default function FollowingIntro({ rows, total }) {
  return (
    <>
      <p className="eyebrow">Your river</p>
      <h1>Following</h1>

      <p className="lede">
        Follow anything in the directory and it arrives here, newest first — one list rather than a
        pile of tabs. There are three kinds of follow, and they answer different questions.
      </p>

      <ul className="post-list">
        <li>
          <strong>
            <a href="/blogs">A blog</a>
          </strong>{' '}
          — tell me when these people post.
        </li>
        <li>
          <strong>
            <a href="/topics">A topic</a>
          </strong>{' '}
          — tell me when <em>anybody</em> posts about this. <a href="/topics/ai">ai</a> and{' '}
          <a href="/topics/ai/podcasts">ai: podcasts</a> are two separate follows, because they are
          two separate pages.
        </li>
        <li>
          <strong>
            <a href="/authors">A person</a>
          </strong>{' '}
          — collect everything they publish, wherever they publish it.
        </li>
      </ul>

      <p>
        Your river also gets its own RSS address, so you can read it in whatever you already use
        instead of coming back here. It is private to your account and can be rotated if it ever
        leaks.
      </p>

      <h2>Start with a few</h2>

      <p className="hint">
        {total > 0 ? `${total.toLocaleString('en')} feeds in the directory. ` : ''}
        These are live rows from it — press Follow on any of them and we will ask you to sign in,
        then bring you straight back.
      </p>

      <div className="feed-index">
        {rows.map((f) => (
          <div className="feed-row" key={String(f.slug)}>
            <Avatar src={feedImage(f)} title={f.title} slug={f.slug} />
            <h3>
              <a href={`/${f.slug}`}>{String(f.title)}</a>
            </h3>
            {f.description && <p>{String(f.description)}</p>}
            <div className="feed-meta">
              <span>{Number(f.item_count ?? 0)} posts</span>
              {/* The real control, signed out. It posts the plain form, the
                  endpoint redirects to sign-in, and `next` brings them back to
                  this page rather than dropping them on the home page. */}
              <FollowButton
                endpoint="/api/follows"
                slug={String(f.slug)}
                following={false}
                signedIn={false}
                next="/following"
                label="Follow"
              />
            </div>
          </div>
        ))}
      </div>

      <p className="lede">
        <a className="button" href="/login?next=%2Ffollowing">
          Sign in to start following
        </a>
      </p>

      <p className="hint">
        A magic link to any address — no password, no card. Passkeys after that if you want them.
      </p>
    </>
  );
}
