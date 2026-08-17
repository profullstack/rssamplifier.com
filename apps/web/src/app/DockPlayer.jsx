'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The player that follows you around the directory.
 *
 * Until now the transport was part of the post: open an episode, get a player
 * docked at the foot of *that page*, and lose it the moment you clicked
 * anything. That is the wrong shape for how this site is used — the whole point
 * of the reader and the roaming toolbar is that you keep browsing — so the
 * player moves up into the layout, where it belongs, and the post hands it a
 * track instead of owning one.
 *
 * Staying alive across a navigation is the whole job, and it is done twice
 * because there are two kinds of navigation here:
 *
 *   1. Links. While something is loaded, same-site links are taken over and
 *      pushed through the router instead. The App Router keeps the layout
 *      mounted across a soft navigation, so the <audio> element is never
 *      unmounted and the sound does not even gap. This is only switched on
 *      while there is something playing: with an idle dock every link on the
 *      site behaves exactly as it did before, which keeps the blast radius of a
 *      global click handler down to the sessions that actually need it.
 *
 *   2. Everything else — a form post, a typed URL, a link we deliberately did
 *      not take over, JavaScript being off for the first paint. Then the page
 *      really does reload, and the dock rebuilds itself from sessionStorage:
 *      same track, same position, playing again if it was playing. There is an
 *      audible gap of a second or so, and that is honest — it is what a reload
 *      costs. It beats losing the episode.
 *
 * Per tab rather than per browser (sessionStorage, not localStorage) so two
 * tabs do not fight over one running order, and closing the tab ends the
 * session rather than ambushing the next one with audio.
 *
 * What it will not do is claim to play things it cannot. A YouTube or PeerTube
 * post lives in somebody else's iframe: it cannot be started from out here,
 * cannot be seeked, and cannot tell us it finished. Those never reach the dock
 * — the queue keeps them, and the play control on them opens the post.
 */

/** Where the tab's player state lives across a reload. */
const STORE = 'rsa.dock';

/** Paths that are files rather than pages, so a soft navigation would break them. */
const NOT_PAGES = new Set(['/opml', '/llms.txt', '/robots.txt', '/sitemap.xml', '/mcp']);

export default function DockPlayer() {
  const router = useRouter();

  /** @type {[any, Function]} */
  const [track, setTrack] = useState(/** @type {any} */ (null));
  /** The lane being played, and what is left of it. */
  const [lane, setLane] = useState('listen');
  const [upNext, setUpNext] = useState(/** @type {any[]} */ ([]));
  // A video shrunk to a thumbnail, and whether this browser will pop one out.
  const [compact, setCompact] = useState(false);
  const [canPop, setCanPop] = useState(false);

  const mediaRef = useRef(/** @type {HTMLMediaElement|null} */ (null));
  // Where to drop the needle once the element has metadata — a resume after a
  // reload, and zero for anything started here.
  const resumeAt = useRef(0);
  const wantPlay = useRef(false);
  // Tracks the reader has closed on this page, so restoring the dock does not
  // fight a reader who just dismissed it.
  const dismissed = useRef(/** @type {Set<string>} */ (new Set()));
  const offered = useRef('');
  const trackRef = useRef(/** @type {any} */ (null));
  const laneRef = useRef('listen');
  const nextRef = useRef(/** @type {any[]} */ ([]));
  // Where "up next" came from: the reader's saved queue, or a running order a
  // page handed over. It decides whether a reload may re-ask the server for the
  // list — asking for a lane when the list is a topic's playlist would replace
  // the forty tracks the reader is working through with their own queue.
  const sourceRef = useRef('lane');

  trackRef.current = track;
  laneRef.current = lane;
  nextRef.current = upNext;

  /* ------------------------------------------------------------- persistence */

  const remember = useCallback(() => {
    const current = trackRef.current;
    if (typeof window === 'undefined') return;

    if (!current) {
      window.sessionStorage.removeItem(STORE);
      return;
    }

    const el = mediaRef.current;
    try {
      window.sessionStorage.setItem(
        STORE,
        JSON.stringify({
          track: current,
          lane: laneRef.current,
          upNext: nextRef.current,
          source: sourceRef.current,
          time: el ? el.currentTime : 0,
          playing: el ? !el.paused && !el.ended : false,
        }),
      );
    } catch {
      // A full or disabled store costs the reader their position on the next
      // reload and nothing else. Not worth taking the player down over.
    }
  }, []);

  /* ------------------------------------------------------------ what to play */

  const load = useCallback(
    /**
     * @param {any} next the track to play
     * @param {{ lane?: string, at?: number, play?: boolean, list?: any[], source?: string }} [opts]
     */
    (next, opts = {}) => {
      if (!next?.src) return;
      resumeAt.current = Number(opts.at ?? 0);
      wantPlay.current = opts.play !== false;
      if (opts.lane) setLane(opts.lane);
      if (opts.source) sourceRef.current = opts.source;
      if (opts.list) {
        // To the ref as well as to state, for the same reason the track is:
        // `advance` reads the running order off the ref, and a reader who
        // presses next before the render lands would otherwise step through an
        // empty list and stop.
        nextRef.current = opts.list;
        setUpNext(opts.list);
      }
      // Written straight to the ref as well as to state: state lands on the
      // next render, and until it does every "is the dock busy" check — the
      // page offer scan being the one that matters — would answer no and load
      // something over the top of this.
      trackRef.current = next;
      setTrack(next);
    },
    [],
  );

  /**
   * Fetch a lane so the player knows what comes after this.
   *
   * Only the entries the dock can carry are kept: an embed in the middle of a
   * running order is not something to stop on, and it stays in the queue for
   * the reader to open themselves.
   */
  const loadLane = useCallback(async (which) => {
    try {
      const res = await fetch(`/api/queue?lane=${encodeURIComponent(which)}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return;
      const data = await res.json();
      const entries = (data.entries ?? []).filter((entry) => entry.track);
      sourceRef.current = 'lane';
      nextRef.current = entries;
      setUpNext(entries);
    } catch {
      // Offline, or signed out mid-session. The current track keeps playing;
      // it just has nothing queued after it.
    }
  }, []);

  /* ------------------------------------------------- the page offering a track */

  // A post that carries dockable media renders a hidden element describing it.
  // The dock takes it only when it is idle: something already playing outranks
  // a page you have merely opened, which is the difference between a player
  // that follows you and a player that interrupts you.
  const scan = useCallback(() => {
    if (trackRef.current) return;

    const node = document.querySelector('[data-dock-offer]');
    if (!node) return;

    const raw = node.getAttribute('data-dock-offer') ?? '';
    if (!raw || raw === offered.current) return;

    try {
      const candidate = JSON.parse(raw);
      if (!candidate?.src || dismissed.current.has(candidate.src)) return;
      offered.current = raw;
      // Loaded but not started. Nothing on this site autoplays; the reader
      // opened a page, which is not the same as asking to hear it.
      load(candidate, { play: false });
    } catch {
      // A malformed offer is a bug in a page, not a reason to break the dock.
    }
  }, [load]);

  /**
   * Flag the play control for whatever is loaded, wherever it is on the page.
   *
   * The playlist page no longer knows what is playing — the dock does — so the
   * row highlight has to come from out here. Matched on an attribute rather
   * than by parsing the JSON payload of every control: a topic's playlist is
   * fifty of them, and this runs again on every navigation.
   */
  const mark = useCallback(() => {
    const src = trackRef.current?.src ?? '';
    for (const node of document.querySelectorAll('[data-dock-src]')) {
      if (src && node.getAttribute('data-dock-src') === src) {
        node.setAttribute('data-dock-current', '');
      } else {
        node.removeAttribute('data-dock-current');
      }
    }
  }, []);

  useEffect(() => {
    mark();
  }, [mark, track]);

  useEffect(() => {
    // Says "there is a roaming player on this page", which is what lets the CSS
    // stand the page's own docked transport down. Set from script and only from
    // script, so a reader with JavaScript off keeps the player they have always
    // had rather than losing it to a component that never ran.
    document.documentElement.setAttribute('data-dock', 'on');

    // Restore first, so a reload mid-episode picks the needle back up before
    // anything on the new page gets a chance to offer its own track.
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(STORE) ?? 'null');
      if (saved?.track?.src) {
        setLane(saved.lane ?? 'listen');
        sourceRef.current = saved.source ?? 'lane';
        nextRef.current = saved.upNext ?? [];
        setUpNext(saved.upNext ?? []);
        resumeAt.current = Number(saved.time ?? 0);
        wantPlay.current = Boolean(saved.playing);
        trackRef.current = saved.track;
        setTrack(saved.track);

        // What is left in the lane, asked again rather than trusted. The stored
        // copy is a snapshot from whenever the position was last written, so a
        // queue changed in another tab — or in the moment before this page
        // navigated — leaves "up next" counting things that are no longer
        // there. Only for a reader who is actually working through a queue:
        // somebody who simply pressed play on a post has nothing to re-ask.
        //
        // And only when the list *is* the queue. A topic's playlist is a
        // running order the page handed over, not anything the server holds —
        // re-asking would answer with the reader's own queue and quietly
        // replace forty episodes of AI podcasts with whatever they saved for
        // later, which is the same lose-the-playlist bug one level up.
        if (
          sourceRef.current === 'lane' &&
          (saved.track.entryId || (saved.upNext ?? []).length > 0)
        ) {
          loadLane(saved.lane ?? 'listen');
        }
      }
    } catch {
      /* nothing worth restoring */
    }

    scan();
    mark();

    // Every way a new page can arrive: our own soft navigations, the back
    // button, and anything else that swaps the document's body out. Coalesced,
    // since a page that streams its own updates (the crawl progress pages do)
    // would otherwise fire this on every row it adds — and both halves are
    // cheap: `scan` returns immediately whenever the dock has a track, and
    // `mark` touches only the play controls a page actually renders.
    let pending = 0;
    const arrived = () => {
      if (pending) return;
      pending = window.setTimeout(() => {
        pending = 0;
        scan();
        // Redrawn while something is playing as well as while nothing is,
        // because that is when it matters: walk from a topic's playlist to a
        // show and back, and the row still says which episode is in the dock.
        mark();
      }, 100);
    };

    const observer = new MutationObserver(arrived);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', arrived);

    return () => {
      observer.disconnect();
      window.clearTimeout(pending);
      window.removeEventListener('popstate', arrived);
      document.documentElement.removeAttribute('data-dock');
    };
  }, [scan, mark, loadLane]);

  /* ------------------------------------------------------- applying the track */

  useEffect(() => {
    const el = mediaRef.current;
    if (!el || !track) return;

    const at = resumeAt.current;
    resumeAt.current = 0;

    const start = () => {
      // Seeking before the element knows how long the file is silently does
      // nothing, which is how a resume turns into "it started from the top".
      if (at > 0 && Number.isFinite(el.duration)) {
        try {
          el.currentTime = at;
        } catch {
          /* an unseekable stream; start where it starts */
        }
      }
      if (wantPlay.current) {
        wantPlay.current = false;
        // Autoplay after a reload is at the browser's discretion, and a refusal
        // is not an error worth showing: the transport is right there, paused,
        // at the position they left it.
        el.play().catch(() => {});
      }
    };

    if (el.readyState >= 1) start();
    else el.addEventListener('loadedmetadata', start, { once: true });

    return () => el.removeEventListener('loadedmetadata', start);
  }, [track]);

  // The lock screen, the headphone button and the media keys. The browser's own
  // controls already do the rest, which is the reason this is a native element
  // and not a hand-built transport.
  useEffect(() => {
    if (!track || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: track.title,
        artist: track.show,
        album: 'RSS Amplifier',
        artwork: track.image ? [{ src: track.image }] : [],
      });
    } catch {
      /* metadata is a nicety */
    }
  }, [track]);

  /* --------------------------------------------------------- moving the queue */

  const advance = useCallback(
    /**
     * @param {number} step
     * @param {boolean} finished whether the current entry played out
     */
    async (step, finished) => {
      const current = trackRef.current;
      const list = nextRef.current;
      const here = list.findIndex((entry) => entry.track?.src === current?.src);
      const target = list[(here === -1 ? -1 : here) + step];

      if (finished && current?.entryId) {
        // Played out, so it leaves the running order — marked done rather than
        // deleted, because a queue is also a record of what you got through and
        // because an accidental skip has to be undoable.
        try {
          await fetch('/api/queue', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ action: 'done', entry: current.entryId, lane: laneRef.current }),
          });
          router.refresh();
        } catch {
          /* the play still happened; the bookkeeping can miss */
        }
      }

      if (!target?.track) {
        if (finished) stop();
        return;
      }
      load(target.track, { play: true, lane: laneRef.current });
    },
    // `stop` is defined below and is stable for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load, router],
  );

  const stop = useCallback(() => {
    const el = mediaRef.current;
    if (el) el.pause();
    const src = trackRef.current?.src;
    if (src) dismissed.current.add(src);
    trackRef.current = null;
    setTrack(null);
    setUpNext([]);
    try {
      window.sessionStorage.removeItem(STORE);
    } catch {
      /* nothing to forget */
    }
  }, []);

  // Skipping from the lock screen and the headphone button. Set here rather
  // than with the metadata above because they have to close over the queue, and
  // they are cleared when there is nothing after this — otherwise the phone
  // shows a next-track button that does nothing.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    const handler = (step) => (upNext.length > 0 ? () => advance(step, false) : null);
    try {
      navigator.mediaSession.setActionHandler('nexttrack', handler(1));
      navigator.mediaSession.setActionHandler('previoustrack', handler(-1));
    } catch {
      /* an older browser; the transport still works */
    }
  }, [advance, upNext]);

  /* ---------------------------------------------- pages talking to the player */

  useEffect(() => {
    /** @param {MouseEvent} event */
    const onClick = (event) => {
      // A play control anywhere on the site: a plain button carrying the track
      // as JSON. Server-rendered, so a list of fifty posts costs fifty buttons
      // and no components.
      const play = /** @type {HTMLElement|null} */ (
        /** @type {HTMLElement} */ (event.target).closest?.('[data-dock-play]')
      );
      if (play) {
        const raw = play.getAttribute('data-dock-play') ?? '';
        try {
          const next = JSON.parse(raw);
          if (next?.src) {
            event.preventDefault();
            dismissed.current.delete(next.src);
            const which = play.getAttribute('data-lane') ?? laneRef.current;

            // "Keep playing while I browse", on a post whose media is playing
            // in the page rather than in the dock. Handing over means handing
            // over the position too — restarting a video forty minutes in is
            // not continuing it — and silencing the element left behind, which
            // is about to be hidden but would otherwise go on playing.
            let at = 0;
            if (play.hasAttribute('data-dock-resume')) {
              const inline = /** @type {HTMLMediaElement|null} */ (
                document.querySelector('.episode-player.is-inline audio, .episode-player.is-inline video')
              );
              if (inline) {
                at = inline.currentTime;
                inline.pause();
                // Two transports showing the same thing is one too many, and
                // the one that just stopped is the one to lose.
                inline.closest('.episode-player')?.setAttribute('data-handed-over', '');
              }
            }

            // A page that ships its own running order — a topic's playlist —
            // hands the whole thing over with the track it was clicked on. The
            // order rides on an ancestor rather than on every row, so a list of
            // fifty episodes carries it once instead of fifty times.
            const list = listFrom(play.closest('[data-dock-list]'));

            load(next, {
              play: true,
              lane: which,
              at,
              list: list ?? undefined,
              source: list ? 'list' : 'lane',
            });
            // The reader's saved queue is only what comes next when the page did
            // not say. Asking for it here would throw away the playlist they
            // just pressed play on.
            if (!list) loadLane(which);
          }
        } catch {
          /* fall through to whatever the button would have done */
        }
        return;
      }

      // Links, but only while something is loaded — see the note at the top.
      if (!trackRef.current) return;
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const link = /** @type {HTMLAnchorElement|null} */ (
        /** @type {HTMLElement} */ (event.target).closest?.('a[href]')
      );
      if (!link || !softNavigable(link)) return;

      event.preventDefault();
      router.push(link.getAttribute('href') ?? '/');
    };

    /** @param {SubmitEvent} event */
    const onSubmit = async (event) => {
      const form = /** @type {HTMLFormElement} */ (event.target);
      if (!form?.matches?.('form[data-soft]')) return;
      // Somebody nearer the form already dealt with it. PostActions handles its
      // own submits exactly this way, and the two handlers are one `data-soft`
      // attribute away from meeting on the same form — at which point the
      // action is posted twice, and "twice" for a vote or a queue add is a
      // different outcome, not a slower one.
      if (event.defaultPrevented) return;

      event.preventDefault();
      try {
        // getAttribute, not form.action. Every one of these forms carries a
        // hidden input named "action", and a named control shadows the form's
        // own property — so form.action is that <input>, fetch stringifies it
        // to "[object HTMLInputElement]", and the queue button posts to a
        // relative path that does not exist. It fails as a 404 from a page
        // route rather than as anything that names the cause.
        const res = await fetch(form.getAttribute('action') ?? '/', {
          method: 'post',
          headers: { accept: 'application/json' },
          body: new FormData(form),
        });

        if (res.status === 401) {
          const next = window.location.pathname + window.location.search;
          window.location.href = `/login?next=${encodeURIComponent(next)}`;
          return;
        }

        // The page's own buttons are server-rendered from the queue, so the
        // way to show the new state is to re-render the page — which, unlike
        // submitting the form, leaves the audio alone.
        router.refresh();
        if (trackRef.current) loadLane(laneRef.current);
      } catch {
        // Whatever went wrong, the reader still asked for something. Let the
        // browser do it the ordinary way — through the prototype, since a
        // control named "submit" would shadow the method the same way.
        HTMLFormElement.prototype.submit.call(form);
      }
    };

    document.addEventListener('click', onClick);
    document.addEventListener('submit', onSubmit);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('submit', onSubmit);
    };
  }, [load, loadLane, router]);

  /* --------------------------------------------------------------- the video */

  // Whether this browser will pop a video out into its own always-on-top
  // window. Asked at runtime rather than assumed: Chrome and Safari have the
  // API, Firefox does the same thing through its own control on the video and
  // exposes nothing to script, and a button that throws is worse than no
  // button. Read in an effect because it is a fact about the browser, and the
  // first render is the server's.
  useEffect(() => {
    setCanPop(Boolean(document.pictureInPictureEnabled));
  }, []);

  // The popout. Worth having beyond the novelty: the picture-in-picture window
  // outlives the tab being scrolled, hidden behind another window, or switched
  // away from entirely — the one place the dock cannot follow the reader, and
  // the browser can.
  const popOut = useCallback(async () => {
    const el = /** @type {any} */ (mediaRef.current);
    if (!el?.requestPictureInPicture) return;

    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch {
      // Refused — no video track yet, or a `disablePictureInPicture` the
      // publisher set. The video is still playing in the dock either way.
    }
  }, []);

  // The position is written on the way out of the page as well as periodically:
  // pagehide is the one event that fires for a reload, a form post and the back
  // button alike, and without it a reload lands a minute behind where it left.
  useEffect(() => {
    const onHide = () => remember();
    window.addEventListener('pagehide', onHide);
    const timer = window.setInterval(remember, 4000);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.clearInterval(timer);
      remember();
    };
  }, [remember]);

  if (!track) return null;

  const video = track.kind === 'video';
  const list = upNext;
  const here = list.findIndex((entry) => entry.track?.src === track.src);
  const remaining = here === -1 ? list.length : list.length - here - 1;

  return (
    <aside
      className={`episode-player dock-player${video ? ' is-video' : ''}${
        video && compact ? ' is-thumb' : ''
      }`}
      aria-label="Now playing"
    >
      <div className="episode-meta">
        <span className="eyebrow">{video ? 'Watching' : 'Listening'}</span>
        <strong title={track.title}>
          <a href={track.href}>{track.title}</a>
        </strong>
        {track.show && <span className="show">{track.show}</span>}
      </div>

      {video ? (
        <video
          key="video"
          ref={/** @type {any} */ (mediaRef)}
          className="episode-video"
          controls
          playsInline
          preload="metadata"
          // The episode's own artwork, standing in until there are frames to
          // show. `preload="metadata"` means a video that has been loaded but
          // not started has nothing to paint, and a black rectangle in the
          // corner of the window says nothing about what is in it.
          poster={track.image ?? undefined}
          src={track.src}
          onEnded={() => advance(1, true)}
          onPause={remember}
          onPlay={remember}
        />
      ) : (
        <audio
          key="audio"
          ref={/** @type {any} */ (mediaRef)}
          className="episode-audio"
          controls
          preload="metadata"
          src={track.src}
          onEnded={() => advance(1, true)}
          onPause={remember}
          onPlay={remember}
        />
      )}

      <div className="dock-controls">
        <button
          type="button"
          onClick={() => advance(-1, false)}
          disabled={here <= 0}
          title="Previous in queue"
          aria-label="Previous in queue"
        >
          {/* Guillemets rather than the media-control glyphs, which are not in
              every font: ⏮ renders as an empty box on a machine with only the
              core fonts installed, which is most Linux servers and some
              phones. */}
          <span aria-hidden="true">«</span>
        </button>
        <button
          type="button"
          onClick={() => advance(1, false)}
          disabled={remaining <= 0}
          title="Next in queue"
          aria-label="Next in queue"
        >
          <span aria-hidden="true">»</span>
        </button>

        {/* Two sizes and a way out of the window, for video only — an audio
            dock is a scrubber and has nothing to make bigger or smaller.

            The glyphs are geometric shapes and an arrow for the same reason the
            skip buttons are guillemets: the obvious picks are not in the core
            font sets. ⧉, the picture-in-picture glyph everything else uses,
            renders as an empty box on a machine with only DejaVu and
            Liberation installed — which is most Linux desktops and this one.
            Checked rather than assumed, by rasterising each candidate against
            the replacement glyph. */}
        {video && (
          <button
            type="button"
            onClick={() => setCompact((was) => !was)}
            title={compact ? 'Show the video full size' : 'Shrink the video to a thumbnail'}
            aria-pressed={compact}
          >
            <span aria-hidden="true">{compact ? '▭' : '▫'}</span>
            <span className="label">{compact ? 'Bigger' : 'Thumbnail'}</span>
          </button>
        )}

        {video && canPop && (
          <button type="button" onClick={popOut} title="Pop the video out of the page">
            <span aria-hidden="true">↗</span>
            <span className="label">Pop out</span>
          </button>
        )}

        <a href={`/queue?lane=${lane}`} title="Your queue">
          Queue{remaining > 0 ? ` · ${remaining}` : ''}
        </a>

        <button type="button" onClick={stop} title="Close the player" aria-label="Close the player">
          <span aria-hidden="true">✕</span>
        </button>
      </div>
    </aside>
  );
}

/**
 * The running order a page is offering, in the shape the queue uses.
 *
 * Page lists carry bare tracks — they have no queue entries, because nothing
 * about a topic's playlist is saved anywhere. Wrapping them as `{ track }` is
 * what lets `advance` walk a playlist and a saved queue with one piece of code
 * instead of two that drift.
 *
 * @param {Element|null} holder the nearest ancestor carrying data-dock-list
 * @returns {any[]|null} null when there is no list to take
 */
function listFrom(holder) {
  if (!holder) return null;

  try {
    const parsed = JSON.parse(holder.getAttribute('data-dock-list') ?? '[]');
    if (!Array.isArray(parsed)) return null;

    const list = parsed.filter((entry) => entry?.src).map((track) => ({ track }));
    return list.length > 0 ? list : null;
  } catch {
    // A malformed list is a bug in a page, not a reason to refuse to play the
    // track the reader actually clicked. They get it on its own.
    return null;
  }
}

/**
 * Is this a link the router can take over without breaking it?
 *
 * Conservative on purpose. Anything that is a download, a file route, another
 * origin, a new tab or a jump within the page is left exactly as the browser
 * would have handled it — a soft navigation to /opml would render an OPML file
 * as a React page, and to a mailto: nothing at all.
 *
 * @param {HTMLAnchorElement} link
 * @returns {boolean}
 */
function softNavigable(link) {
  if (link.target && link.target !== '_self') return false;
  if (link.hasAttribute('download')) return false;
  if (link.getAttribute('rel')?.includes('external')) return false;

  const href = link.getAttribute('href') ?? '';
  if (!href || href.startsWith('#')) return false;

  let url;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return false;
  }

  if (url.origin !== window.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false;
  if (NOT_PAGES.has(url.pathname)) return false;
  // A dot in the last segment means a file: /feed.rss, /list.opml, /icon.svg.
  // Subscribing to a blog is a link like that, and it must reach the browser's
  // own downloader rather than the router.
  if (/\.[a-z0-9]{2,5}$/i.test(url.pathname)) return false;
  // Same page, different anchor — the browser scrolls, and pushing would
  // reload a page the reader is already on.
  if (url.pathname === window.location.pathname && url.search === window.location.search) {
    return false;
  }

  return true;
}
