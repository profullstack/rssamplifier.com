import { freshness, FRESHNESS_LABEL } from '../lib/freshness.js';

/**
 * When this feed was last read, and whether it is still publishing.
 *
 * Shown on every feed page, on purpose, including the boring case. A freshness
 * signal that only appears when something is wrong is worth very little: a
 * reader cannot tell "this feed is fine" from "this page does not show that",
 * so the absence carries no information and the presence reads as an alarm.
 * Shown always, it is a fact about the feed like its host or its post count.
 *
 * The `<time>` elements carry machine-readable instants as well as the prose,
 * because the readers this most matters to are not people. An agent pulling a
 * post out of the directory is trusting two things it cannot check for itself —
 * that we read the publisher recently, and that the publisher is still
 * publishing — and both are now on the page it is already parsing.
 *
 * @param {object} props
 * @param {object} props.feed the feeds row
 * @param {unknown} [props.newestPost] the newest post's published_at
 */
export default function Freshness({ feed, newestPost = null }) {
  // The stored column first, the loaded list second. `last_published_at` is
  // written by the crawler (0030) and is null on any feed not re-crawled since
  // that column existed, so the page falls back to the newest post it has
  // already loaded — which means the signal is correct immediately for anything
  // anybody actually looks at, rather than after a full crawl cycle.
  const f = freshness(feed, feed?.last_published_at ?? newestPost);

  return (
    <p className={`freshness freshness-${f.state}`}>
      <strong>{FRESHNESS_LABEL[f.state]}</strong>{' '}
      {f.checkedAt ? (
        <>
          Last read <time dateTime={f.checkedAt}>{f.checkedGap} ago</time>
        </>
      ) : (
        <>Never read successfully</>
      )}
      {f.publishedAt && (
        <>
          {' · '}last published <time dateTime={f.publishedAt}>{f.publishedGap} ago</time>
        </>
      )}
      {f.nextCheckAt && (
        <>
          {' · '}next check <time dateTime={f.nextCheckAt}>{f.checkedAt ? 'scheduled' : 'queued'}</time>
        </>
      )}
      {/* The sentence, for the states where the two timestamps alone would be
          read wrongly. A dormant feed's numbers look healthy until somebody
          says out loud that the publisher has stopped. */}
      {(f.state === 'dormant' || f.state === 'failing' || f.state === 'overdue' || f.state === 'unread') && (
        <>
          <br />
          <span className="freshness-note">{f.note}</span>
        </>
      )}
    </p>
  );
}
