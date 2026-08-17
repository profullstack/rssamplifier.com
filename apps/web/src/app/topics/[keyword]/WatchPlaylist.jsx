import { runtime } from '../../../lib/player.js';
import { embedded, trackFor } from '../../../lib/queue.js';

/**
 * A topic's videos, as a list you press play on and a player that follows you.
 *
 * The audio playlist puts its transport in the page — see PlaylistPlayer — and
 * that is right for a podcast, where the page is a list of episodes and the
 * sound comes out of it wherever you are. It is wrong for video twice over: a
 * player in the flow is a player you scroll away from, and a reader who came to
 * watch a topic's videos wants to keep browsing the topic while one plays.
 *
 * So this ships no transport at all. Every row is a play control of the kind
 * the rest of the site already uses, the dock in the layout picks them up, and
 * the video plays at the foot of the window — in the corner on a wide screen —
 * for as long as the reader stays on the site. `data-dock-list` marks the whole
 * list as a running order, which is what makes « and » in the dock step through
 * this topic rather than through the reader's saved queue.
 *
 * Not a client component, and that is the point of doing it this way: fifty
 * videos cost fifty anchors and no JavaScript. Without the dock — script off,
 * or before it hydrates — each row is a link to the post, which is a page that
 * plays the thing. Nothing here is worse than a link.
 *
 * @param {{
 *   rows: Record<string, unknown>[],
 *   label: string,
 * }} props
 */
export default function WatchPlaylist({ rows, label }) {
  const entries = rows
    .map((row) => {
      const slug = String(row.feed_slug ?? '');
      if (!slug) return null;
      return trackFor(row, { slug, feedTitle: String(row.feed_title ?? '') });
    })
    .filter(Boolean);

  if (entries.length === 0) return null;

  // How many play in somebody else's frame. Worth saying out loud rather than
  // letting the reader discover it: those cannot be resumed where they left
  // off and cannot tell the dock they have ended, so the queue stops rolling
  // on at them and waits to be told to move.
  const embeds = entries.filter((track) => embedded(track.kind)).length;

  return (
    <div
      className="playlist-player watch-playlist"
      // Marks these rows as one running order. Empty on purpose — the dock
      // reads the tracks off the rows themselves. See listOn in DockPlayer.
      data-dock-list=""
      // What the dock loads if it is idle when this page opens: the first
      // video, ready, not playing. Nothing on this site starts on its own.
      data-dock-offer={JSON.stringify(entries[0])}
      aria-label={`${label} — videos`}
    >
      <ol className="playlist-tracks">
        {entries.map((track, i) => (
          <li key={`${track.src}-${i}`}>
            <a
              // The post, for anyone the dock is not running for. With it
              // running the click is taken over and the video docks instead.
              href={track.href}
              className="playlist-pick"
              data-dock-play={JSON.stringify(track)}
              data-lane="watch"
              title={`Play ${track.title}`}
            >
              <span className="playlist-num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="playlist-title">{track.title}</span>
              {track.show && <span className="playlist-show">{track.show}</span>}
              {track.seconds ? (
                <span className="playlist-time">{runtime(track.seconds)}</span>
              ) : null}
            </a>
          </li>
        ))}
      </ol>

      {embeds > 0 && (
        <p className="hint">
          {embeds === entries.length
            ? 'These all play in the publisher’s own player'
            : `${embeds} of these play in the publisher’s own player`}
          , so the queue waits for you to press <span aria-hidden="true">»</span> rather than
          rolling on by itself.
        </p>
      )}
    </div>
  );
}
