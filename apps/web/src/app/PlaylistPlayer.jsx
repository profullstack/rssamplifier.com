import { runtime } from '../lib/player.js';
import QueueButton from './QueueButton.jsx';

/**
 * A playlist, as a running order for the docked player.
 *
 * This used to be a player. It had `'use client'` at the top, an `<audio>` of
 * its own, an index, and a queue — and every bit of that died the moment the
 * reader clicked anything, because a component on a page cannot outlive the
 * page. Press play on a topic's podcasts, open one of the shows, and the
 * episode stopped. That is the one thing a playlist must not do.
 *
 * So the transport moved out and up. The dock in the layout is mounted for the
 * whole session, survives a soft navigation without gapping the audio, and
 * rebuilds itself from sessionStorage after a real page load — see DockPlayer.
 * What is left here is the list, which is the part that genuinely belongs to
 * the page: fifty rows of server-rendered HTML, no client bundle, no hydration.
 *
 * Every row is still a real `<a href="…mp3">`, and the dock's click handler is
 * an interception rather than the mechanism. With JavaScript off — or before
 * the dock has hydrated, which on a slow connection is the same thing —
 * following a row plays the file in the browser's own media viewer, exactly as
 * it did before. That is a worse experience than the queue and an enormously
 * better one than the `.m3u`, which is a download that does nothing.
 *
 * The whole order rides on the `<ol>` as one attribute rather than on fifty
 * buttons: the dock reads it off the ancestor when a row is picked, so pressing
 * play on track nine queues ten through fifty behind it without the page
 * repeating itself fifty times over.
 *
 * Each row also carries a queue button, which is the other thing a playlist is
 * for. Playing is a now; queueing is a later, and a list of fifty episodes with
 * no way to keep one was asking the reader to remember it. One lane per row —
 * the lane the media itself belongs in — because the read lane is about the
 * post rather than the file, and it is offered where the post is, behind
 * "Notes". Fifty rows is exactly where a second button per row stops being a
 * choice and starts being noise.
 *
 * @param {{
 *   entries: Array<{
 *     id: string,
 *     src: string,
 *     title: string,
 *     show: string|null,
 *     postHref: string|null,
 *     seconds: number|null,
 *     dock: object|null,
 *     lane: string,
 *     slug?: string|null,
 *     guid?: string,
 *     itemId?: string|null,
 *   }>,
 *   label: string,
 *   queued?: Record<string, ('read'|'listen'|'watch')[]>,
 *   next?: string,
 * }} props
 */
export default function PlaylistPlayer({ entries, label, queued = {}, next = '/queue' }) {
  if (entries.length === 0) return null;

  // Only what the dock can actually carry. An embed in the middle of a running
  // order is not something to stop on, and leaving it in would put a track in
  // "up next" that the next button can never reach.
  const order = entries.map((entry) => entry.dock).filter(Boolean);

  return (
    <div className="playlist-player">
      {/* Shown only where the dock is running, because it is the only place it
          is true. Set from script by the dock itself, so a reader with
          JavaScript off is not told about a player they do not have. */}
      <p className="playlist-hint">
        Pick anything below and it plays in the bar at the foot of the window —
        and keeps playing while you go on browsing the directory.
      </p>

      <ol
        className="playlist-tracks"
        aria-label={label}
        data-dock-list={order.length > 0 ? JSON.stringify(order) : undefined}
        // Where the running order came from, so the dock can say so. Playing a
        // playlist is not the same as working through your queue, and a dock
        // that called forty borrowed tracks "Queue · 39" was sending readers to
        // a page holding one saved post and no explanation.
        data-dock-list-href={order.length > 0 ? next : undefined}
      >
        {entries.map((entry, i) => (
          <li key={entry.id}>
            <a
              href={entry.src}
              className="playlist-pick"
              // Read by DockPlayer's delegated click handler, the same way every
              // other play control on the site is.
              data-dock-play={entry.dock ? JSON.stringify(entry.dock) : undefined}
              data-dock-src={entry.dock ? entry.src : undefined}
              data-lane={entry.dock ? entry.lane : undefined}
            >
              <span className="playlist-num" aria-hidden="true">
                {i + 1}
              </span>
              {/* The marker for the row the dock is on. A second element rather
                  than a swapped-out number, because the swap has to happen in
                  CSS: the dock flags the row it is playing with an attribute,
                  and the page it is playing from may not be this one. */}
              <span className="playlist-live" aria-hidden="true">
                ▶
              </span>
              <span className="playlist-title">{entry.title}</span>
              {entry.show && <span className="playlist-show">{entry.show}</span>}
              {entry.seconds && <span className="playlist-time">{runtime(entry.seconds)}</span>}
            </a>
            {entry.postHref && (
              <a className="playlist-notes" href={entry.postHref} rel="noopener nofollow">
                Notes
              </a>
            )}

            {/* Queueable whatever the dock can carry: a YouTube or PeerTube
                entry has no dock payload and still belongs in the watch lane,
                where its turn opens the post it plays on. */}
            {entry.slug && entry.guid && (
              <span className="playlist-queue">
                <QueueButton
                  slug={entry.slug}
                  guid={entry.guid}
                  lanes={[/** @type {'listen'|'watch'|'read'} */ (entry.lane)]}
                  queued={entry.itemId ? (queued[entry.itemId] ?? []) : []}
                  next={next}
                  compact
                />
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
