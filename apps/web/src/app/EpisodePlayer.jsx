import { mediaKind } from '../lib/media.js';

/**
 * The episode, playing while you read it.
 *
 * A podcast post is the one case where the page and the thing it is about are
 * different media: the show notes are worth reading and the episode is worth
 * hearing, and making a reader choose between them is the wrong call. So the
 * player docks at the foot of the reader and the post scrolls behind it.
 *
 * A plain `<audio controls>` rather than a custom transport. The browser's own
 * player already knows how to seek, buffer, remember position on a back
 * navigation, keep playing when the tab is hidden, and hand off to the phone's
 * lock screen and to the OS media keys — all of which a hand-built one has to
 * reimplement, in JavaScript, on a site that otherwise ships none.
 *
 * `preload="none"` is the important attribute: an episode is tens of megabytes
 * and nobody who opened the show notes has yet said they want to hear it.
 *
 * `inline` is the other half of that argument. Docking is right for a podcast,
 * where the show notes are the page and the audio plays behind them. It is
 * wrong for a video, where the video *is* the post and everything else on the
 * page is a caption: a video post docked in the corner is the thing the reader
 * came for, shrunk to a third of a column, with the middle of the screen given
 * over to an apology about framing.
 *
 * @param {{
 *   src: string,
 *   type?: string|null,
 *   title: string,
 *   seconds?: number|null,
 *   feedTitle?: string|null,
 *   inline?: boolean,
 * }} props
 */
export default function EpisodePlayer({ src, type, title, seconds, feedTitle, inline = false }) {
  // The same reading of the enclosure the reader page uses to decide whether
  // the post is watched or read. Two answers to "is this a video" that can
  // disagree is how a page ends up rendering a docked audio bar for a video.
  const kind = mediaKind({ audio_url: src, audio_type: type });
  const youtube = kind === 'youtube';
  const video = kind === 'video';

  return (
    <aside
      className={`episode-player${youtube || video ? ' is-video' : ''}${inline ? ' is-inline' : ''}`}
      aria-label={video || youtube ? 'Episode video' : 'Episode audio'}
    >
      <div className="episode-meta">
        <span className="eyebrow">{video || youtube ? 'Watch' : 'Listen'}</span>
        <strong title={title}>{title}</strong>
        {feedTitle && <span className="show">{feedTitle}</span>}
        {seconds ? <span className="runtime">{formatRuntime(seconds)}</span> : null}
      </div>

      {/* Three media, three elements. A YouTube video has no file to play —
          the watch page refuses to be framed and the media itself is not
          addressable — so its embed is the only form that works, and it is the
          one case here that loads a third-party frame. */}
      {youtube ? (
        <iframe
          className="episode-video"
          src={src}
          title={title}
          // Eager when it is the post itself: a lazy frame that has not loaded
          // is a black rectangle where the video should be.
          loading={inline ? 'eager' : 'lazy'}
          // No referrerPolicy, and this is not an oversight. YouTube authorizes
          // an embed by its Referer, and `no-referrer` — which this had —
          // leaves it with nothing to authorize: the player refused every video
          // on the site with "Video player configuration error", Error 153.
          // Measured on the live origin: dropping this attribute alone fixes
          // it, and the sandbox below is not implicated either way.
          allow="accelerometer; encrypted-media; picture-in-picture; fullscreen"
          sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
        />
      ) : video ? (
        <video className="episode-video" controls preload="none" playsInline>
          <source src={src} type={type ?? 'video/mp4'} />
          <a href={src} rel="noopener">
            Download the video
          </a>
        </video>
      ) : (
        <audio className="episode-audio" controls preload="none" src={src}>
          {type && <source src={src} type={type} />}
          <a href={src} rel="noopener">
            Download the episode
          </a>
        </audio>
      )}
    </aside>
  );
}

/**
 * A duration a person can read at a glance: 1:04:20, or 42:07.
 *
 * @param {number} total seconds
 * @returns {string}
 */
function formatRuntime(total) {
  const seconds = Math.max(0, Math.floor(Number(total) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}
