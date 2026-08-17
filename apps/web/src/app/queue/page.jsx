import { redirect } from 'next/navigation';
import { queue } from '@rssamplifier/db';

import { db } from '../../lib/db.js';
import { currentUser } from '../../lib/auth.js';
import { LANE_LABEL, trackFor } from '../../lib/queue.js';
import PlayButton from '../PlayButton.jsx';
import Toolbar from '../Toolbar.jsx';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Queue',
  description: 'What you have lined up to read, listen to and watch.',
  // One reader's running order. Nothing here belongs in an index.
  robots: { index: false, follow: false },
};

/** What each lane is for, said once at the top of it. */
const LANE_BLURB = {
  read: 'Posts you mean to sit down with.',
  listen: 'Episodes and tracks, in the order the player will take them.',
  watch: 'Videos, in the order you lined them up.',
};

/**
 * The reader's queue: three running orders, and the controls to work them.
 *
 * Three lanes rather than one list because "later" is not one intention — an
 * hour-long read, a walk's worth of podcast and a video you need a screen for
 * are three different moments, and a single list mixing them starts every one
 * of those moments with skipping past the other two.
 *
 * Every control is a plain form posting to /api/queue, so the page works with
 * JavaScript off. They carry `data-soft` as well, which is what lets the docked
 * player post them in the background: reordering your queue while listening to
 * it should not stop the music.
 *
 * @param {{ searchParams: Promise<{ lane?: string, done?: string }> }} props
 */
export default async function QueuePage({ searchParams }) {
  const { lane: asked, done: showDone } = await searchParams;

  const user = await currentUser();
  if (!user) redirect('/login?next=%2Fqueue');

  const lane = queue.isLane(asked) ? asked : 'listen';
  const done = showDone === '1';

  const client = db();
  const userId = String(user.id);

  const [entries, counts] = await Promise.all([
    queue.list(client, userId, lane, { done }),
    queue.counts(client, userId),
  ]);

  const here = `/queue?lane=${lane}${done ? '&done=1' : ''}`;

  return (
    <>
      <h1>Queue</h1>
      <p className="lede">{LANE_BLURB[lane]}</p>

      <nav className="lane-tabs" aria-label="Queue lanes">
        {queue.LANES.map((name) => (
          <a
            key={name}
            href={`/queue?lane=${name}`}
            className={name === lane && !done ? 'on' : undefined}
            aria-current={name === lane && !done ? 'page' : undefined}
          >
            {LANE_LABEL[name]}
            {counts[name] > 0 && <span className="count">{counts[name]}</span>}
          </a>
        ))}
        {/* Finished entries are kept rather than deleted — the player marks an
            episode done the moment it plays out, and a row that vanished at
            that point would make an accidental skip unrecoverable. */}
        <a href={`/queue?lane=${lane}&done=1`} className={done ? 'on' : undefined}>
          Finished
        </a>
      </nav>

      {entries.length === 0 ? (
        <p className="empty">
          {done ? (
            <>Nothing finished in this lane yet.</>
          ) : (
            <>
              Nothing lined up. The <strong>{LANE_LABEL[lane]} later</strong> button on a post puts
              it here — try <a href="/random">a random blog</a>, the{' '}
              <a href="/podcasts">podcasts</a> or the <a href="/videos">videos</a>.
            </>
          )}
        </p>
      ) : (
        <ol className="queue-list">
          {entries.map((entry, i) => {
            const slug = String(entry.feed_slug);
            const guid = String(entry.guid);
            const id = String(entry.id);
            const href = `/${slug}/read?p=${encodeURIComponent(guid)}`;
            const track = trackFor(entry, {
              slug,
              feedTitle: String(entry.feed_title),
              entryId: id,
            });

            return (
              <li key={id}>
                <div className="queue-entry">
                  {/* Order is the point of a queue, so the position is shown
                      rather than left implicit in the layout. */}
                  <span className="queue-index" aria-hidden="true">
                    {i + 1}
                  </span>

                  <div className="queue-body">
                    <a className="queue-title" href={href}>
                      {String(entry.title)}
                    </a>
                    <p className="meta">
                      <a href={`/${slug}`}>{String(entry.feed_title)}</a>
                      {entry.published_at ? ` · ${when(entry.published_at)}` : ''}
                      {entry.audio_seconds ? ` · ${runtime(Number(entry.audio_seconds))}` : ''}
                    </p>
                  </div>

                  <div className="queue-controls">
                    {lane !== 'read' && (
                      <PlayButton
                        track={track}
                        lane={lane}
                        href={href}
                        className="queue-play"
                        label="Play"
                      />
                    )}

                    {!done && (
                      <>
                        <Control entry={id} action="up" next={here} label="Move up" disabled={i === 0}>
                          ▲
                        </Control>
                        <Control
                          entry={id}
                          action="down"
                          next={here}
                          label="Move down"
                          disabled={i === entries.length - 1}
                        >
                          ▼
                        </Control>
                      </>
                    )}

                    <Control
                      entry={id}
                      action={done ? 'undone' : 'done'}
                      next={here}
                      label={done ? 'Put back in the queue' : 'Mark finished'}
                    >
                      {done ? '↺' : '✓'}
                    </Control>

                    <Control entry={id} action="remove" next={here} label="Remove from the queue">
                      ✕
                    </Control>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {done && entries.length > 0 && (
        <form method="post" action="/api/queue" className="queue-clear" data-soft>
          <input type="hidden" name="action" value="clear-done" />
          <input type="hidden" name="lane" value={lane} />
          <input type="hidden" name="next" value={here} />
          <button type="submit" className="secondary-button">
            Clear finished
          </button>
        </form>
      )}

      <Toolbar />
    </>
  );
}

/**
 * One control on one entry, as its own form — the same shape as the reaction
 * buttons in the reader.
 *
 * @param {{
 *   entry: string,
 *   action: string,
 *   next: string,
 *   label: string,
 *   disabled?: boolean,
 *   children: React.ReactNode,
 * }} props
 */
function Control({ entry, action, next, label, disabled = false, children }) {
  return (
    <form method="post" action="/api/queue" className="inline-form" data-soft>
      <input type="hidden" name="entry" value={entry} />
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="next" value={next} />
      <button type="submit" title={label} aria-label={label} disabled={disabled}>
        <span aria-hidden="true">{children}</span>
      </button>
    </form>
  );
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

/**
 * @param {number} total seconds
 * @returns {string}
 */
function runtime(total) {
  const seconds = Math.max(0, Math.floor(Number(total) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}
