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
 * @param {{
 *   src: string,
 *   type?: string|null,
 *   title: string,
 *   seconds?: number|null,
 *   feedTitle?: string|null,
 * }} props
 */
export default function EpisodePlayer({ src, type, title, seconds, feedTitle }) {
  const youtube = type === 'video/youtube';
  const video = !youtube && /^video\//i.test(String(type ?? ''));

  return (
    <aside
      className={`episode-player${youtube || video ? ' is-video' : ''}`}
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
          loading="lazy"
          referrerPolicy="no-referrer"
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
