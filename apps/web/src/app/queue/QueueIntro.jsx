/**
 * What /queue is, shown to somebody who has not signed in.
 *
 * Same reasoning as FollowingIntro next door: this page used to answer a
 * signed-out visitor with `redirect('/login')`, which asks them to want
 * something they have never been shown. The queue is the harder of the two to
 * guess at from the name — "queue" could mean a dozen things — so the three
 * lanes and why there are three is most of what this page has to say.
 *
 * No live sample here, unlike the following page. A queue is empty by
 * definition until somebody fills it, and a fake one with somebody else's posts
 * in it would be showing a thing that is not true rather than a thing that is
 * not yours.
 *
 * @param {{ lanes: Array<{ key: string, label: string, blurb: string }> }} props
 */
export default function QueueIntro({ lanes }) {
  return (
    <>
      <p className="eyebrow">Later</p>
      <h1>Queue</h1>

      <p className="lede">
        Anything in the directory can be put aside for later. The queue keeps three running orders
        rather than one, because &ldquo;later&rdquo; is not a single intention: an hour-long read, a
        walk&rsquo;s worth of podcast and a video you need a screen for are three different moments,
        and one list mixing them starts every one of those moments with skipping past the other two.
      </p>

      <ul className="post-list">
        {lanes.map((l) => (
          <li key={l.key}>
            <strong>{l.label}</strong> — {l.blurb}
          </li>
        ))}
      </ul>

      <p>
        The listen lane is also the player&rsquo;s running order: press play on anything queued and
        it takes them in turn, so a queue built over a week is a podcast episode list without any of
        the app that usually comes with one. Reordering while it plays does not stop the music.
      </p>

      <p className="lede">
        <a className="button" href="/login?next=%2Fqueue">
          Sign in to start a queue
        </a>
      </p>

      <p className="hint">
        A magic link to any address — no password, no card. Or go and find something first:{' '}
        <a href="/podcasts">podcasts</a>, <a href="/videos">videos</a>, <a href="/blogs">blogs</a>.
      </p>
    </>
  );
}
