'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { runtime } from '../lib/player.js';

/**
 * A playlist, playing.
 *
 * The transport is one `<audio controls>` and nothing else. The browser's own
 * player already knows how to seek, buffer, survive a back navigation, keep
 * playing while the tab is hidden, and answer the OS media keys and the phone's
 * lock screen — a hand-built set of buttons has to reimplement all of that, in
 * JavaScript, on a site that otherwise ships almost none. What this component
 * adds is the one thing a lone `<audio>` cannot do: a queue. Pick a track, and
 * when it ends the next one starts.
 *
 * Every row below is a real `<a href="…mp3">` and the click handler is an
 * interception, not the mechanism. With JavaScript off — or before this
 * component has hydrated, which on a slow connection is the same thing — the
 * list is a page of links to audio files, and following one plays it in the
 * browser's own media viewer. That is a worse experience than the queue and an
 * enormously better one than the `.m3u`, which is a download that does nothing.
 *
 * `preload="none"` is load-bearing: a queue is fifty episodes and an episode is
 * tens of megabytes. Nothing is fetched until a reader asks for something.
 *
 * @param {{
 *   tracks: Array<{
 *     id: string,
 *     src: string,
 *     type: string|null,
 *     title: string,
 *     show: string|null,
 *     showHref: string|null,
 *     postHref: string|null,
 *     seconds: number|null,
 *   }>,
 *   label: string,
 * }} props
 */
export default function PlaylistPlayer({ tracks, label }) {
  const audioRef = useRef(null);
  const [index, setIndex] = useState(0);
  // Whether the reader has ever pressed play. Until they have, changing the
  // selection must not start anything — the first track is *selected* on load
  // so the transport has something to show, and a page that began playing on
  // its own would be the rudest thing on the site.
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);

  const current = tracks[index] ?? null;

  const select = useCallback((next) => {
    setIndex(next);
    setStarted(true);
  }, []);

  // A new selection is a new file in the same element, so the element has to be
  // told to go and get it: assigning `src` alone leaves some browsers playing
  // the old buffer. Only autoplays once the reader has started, which is also
  // what keeps this inside the user gesture the browser requires.
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !current) return;

    el.load();
    if (started) el.play().catch(() => setPlaying(false));
  }, [current, started]);

  const step = useCallback(
    (by) => {
      const next = index + by;
      if (next < 0 || next >= tracks.length) return;
      select(next);
    },
    [index, tracks.length, select],
  );

  // The lock screen, the OS media keys, and the little media widget in the
  // browser's own toolbar. Twenty lines to make a web page behave like the
  // podcast app the reader would otherwise have gone and opened.
  useEffect(() => {
    const session = globalThis.navigator?.mediaSession;
    if (!session || !current) return undefined;

    session.metadata = new globalThis.MediaMetadata({
      title: current.title,
      artist: current.show ?? '',
      album: label,
    });

    session.setActionHandler('previoustrack', index > 0 ? () => step(-1) : null);
    session.setActionHandler('nexttrack', index < tracks.length - 1 ? () => step(1) : null);

    return () => {
      session.setActionHandler('previoustrack', null);
      session.setActionHandler('nexttrack', null);
    };
  }, [current, index, tracks.length, label, step]);

  if (!current) return null;

  return (
    <div className="playlist-player">
      <div className="playlist-now" aria-live="polite">
        <span className="eyebrow">{playing ? 'Playing' : 'Up next'}</span>
        <strong title={current.title}>{current.title}</strong>
        {current.show && (
          <span className="show">
            {current.showHref ? <a href={current.showHref}>{current.show}</a> : current.show}
          </span>
        )}
      </div>

      <audio
        ref={audioRef}
        className="playlist-audio"
        controls
        preload="none"
        src={current.src}
        onPlay={() => {
          setStarted(true);
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        // The queue, in one line. Nothing to advance to at the end of the last
        // track, and stopping there is the right answer: looping a fifty-episode
        // playlist back to the top is a decision the reader did not make.
        onEnded={() => step(1)}
      >
        {current.type && <source src={current.src} type={current.type} />}
        <a href={current.src} rel="noopener">
          Download this episode
        </a>
      </audio>

      <ol className="playlist-tracks">
        {tracks.map((track, i) => (
          <li
            key={track.id}
            className={i === index ? 'is-current' : undefined}
            aria-current={i === index ? 'true' : undefined}
          >
            <a
              href={track.src}
              className="playlist-pick"
              onClick={(event) => {
                // Let the reader keep every escape hatch a link has: a modified
                // click, or a middle click, still opens the file itself.
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                select(i);
              }}
            >
              <span className="playlist-num" aria-hidden="true">
                {i === index && playing ? '▶' : i + 1}
              </span>
              <span className="playlist-title">{track.title}</span>
              {track.show && <span className="playlist-show">{track.show}</span>}
              {track.seconds && (
                <span className="playlist-time">{runtime(track.seconds)}</span>
              )}
            </a>
            {track.postHref && (
              <a className="playlist-notes" href={track.postHref} rel="noopener nofollow">
                Notes
              </a>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
