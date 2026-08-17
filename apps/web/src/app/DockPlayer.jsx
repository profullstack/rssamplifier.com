'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { dockable, embedded } from '../lib/queue.js';

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
 * A YouTube or PeerTube post lives in somebody else's iframe, and the dock
 * carries those too — see `dockCarries` in lib/queue.js for why, and for the
 * line between carrying one and driving one. Everything below that reaches into
 * a media element asks `dockable` first, so an embed simply skips it: no
 * resume-to-position after a reload, and no automatic advance when it ends,
 * because neither is knowable from outside the frame. What it does get is the
 * one thing the dock exists for, which is to still be there on the next page.
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
  // Whether the running order came from a page — a topic's watch playlist —
  // rather than from the reader's own queue. The two must not be confused: a
  // page list has no entries to mark done, and re-asking the queue for it would
  // replace fifty videos on a topic with whatever the reader saved last week.
  const [pageList, setPageList] = useState(false);
  // Whether the embed should start itself. Only ever set by a click on a play
  // control, which is both what the reader asked for and the user gesture the
  // browser requires before it will let a frame make noise. A restore after a
  // reload never sets it: the reader pressed play on the last page, not this
  // one, and a video that starts talking on its own is the thing this whole
  // directory is a reaction to.
  const [autoplay, setAutoplay] = useState(false);

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
  const pageListRef = useRef(false);

  trackRef.current = track;
  laneRef.current = lane;
  nextRef.current = upNext;
  pageListRef.current = pageList;

  /* ------------------------------------------------------------- persistence */

  const remember = useCallback(() => {
    const current = trackRef.current;
    if (typeof window === 'undefined') return;

    if (!current) {
      window.sessionStorage.removeItem(STORE);
      return;
    }

    // An embed has no element to ask, and guessing would be worse than not
    // asking: an iframe answers `paused` with undefined, which reads as playing.
    const el = dockable(current.kind) ? mediaRef.current : null;
    try {
      window.sessionStorage.setItem(
        STORE,
        JSON.stringify({
          track: current,
          lane: laneRef.current,
          upNext: nextRef.current,
          pageList: pageListRef.current,
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
     * @param {{ lane?: string, at?: number, play?: boolean, list?: any[], fromPage?: boolean }} [opts]
     */
    (next, opts = {}) => {
      if (!next?.src) return;
      resumeAt.current = Number(opts.at ?? 0);
      wantPlay.current = opts.play !== false;
      setAutoplay(opts.play !== false && embedded(next.kind));
      if (opts.lane) setLane(opts.lane);
      if (opts.list) {
        setUpNext(opts.list);
        setPageList(Boolean(opts.fromPage));
        pageListRef.current = Boolean(opts.fromPage);
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
      setUpNext((data.entries ?? []).filter((entry) => entry.track));
      setPageList(false);
      pageListRef.current = false;
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
      load(candidate, { play: false, ...listOn(node) });
    } catch {
      // A malformed offer is a bug in a page, not a reason to break the dock.
    }
  }, [load]);

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
        setUpNext(saved.upNext ?? []);
        setPageList(Boolean(saved.pageList));
        pageListRef.current = Boolean(saved.pageList);
        resumeAt.current = Number(saved.time ?? 0);
        wantPlay.current = Boolean(saved.playing);
        trackRef.current = saved.track;
        setTrack(saved.track);

        // What is left in the lane, asked again rather than trusted. The stored
        // copy is a snapshot from whenever the position was last written, so a
        // queue changed in another tab — or in the moment before this page
        // navigated — leaves "up next" counting things that are no longer
        // there. Only for a reader who is actually working through a queue:
        // somebody who simply pressed play on a post has nothing to re-ask,
        // and somebody playing a topic's own list is not in a queue at all.
        if (!saved.pageList && (saved.track.entryId || (saved.upNext ?? []).length > 0)) {
          loadLane(saved.lane ?? 'listen');
        }
      }
    } catch {
      /* nothing worth restoring */
    }

    scan();

    // Every way a new page can arrive: our own soft navigations, the back
    // button, and anything else that swaps the document's body out. Cheaper
    // than it looks — the callback returns immediately whenever the dock has a
    // track, which is most of the time it is running at all — and coalesced
    // besides, since a page that streams its own updates (the crawl progress
    // pages do) would otherwise fire this on every row it adds.
    let pending = 0;
    const observer = new MutationObserver(() => {
      if (pending || trackRef.current) return;
      pending = window.setTimeout(() => {
        pending = 0;
        scan();
      }, 100);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', scan);

    return () => {
      observer.disconnect();
      window.clearTimeout(pending);
      window.removeEventListener('popstate', scan);
      document.documentElement.removeAttribute('data-dock');
    };
  }, [scan, loadLane]);

  /* ------------------------------------------------------- applying the track */

  useEffect(() => {
    const el = mediaRef.current;
    // Nothing to seek and nothing to start: an embed governs its own transport
    // from inside the frame, and the reader presses its play button, not ours.
    if (!el || !track || !dockable(track.kind)) return;

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
    // An embed publishes its own metadata to the OS from inside the frame.
    // Ours would overwrite it with the same title and a play button that
    // controls nothing.
    if (!dockable(track.kind)) return;

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
    if (el && typeof el.pause === 'function') el.pause();
    const src = trackRef.current?.src;
    if (src) dismissed.current.add(src);
    trackRef.current = null;
    setTrack(null);
    setUpNext([]);
    setPageList(false);
    pageListRef.current = false;
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
              }
              // Two players showing the same thing is one too many, and the one
              // being handed over is the one to lose. Done off the player
              // rather than off the media element, because an embed has no
              // media element to find — and an embed left running behind the
              // dock is not merely redundant, it is the same video playing
              // twice, out of sync, out loud.
              (inline?.closest('.episode-player') ??
                document.querySelector('.episode-player.is-inline'))?.setAttribute(
                'data-handed-over',
                '',
              );
            }

            // A page can hand over its whole running order — a topic's watch
            // playlist does — and when it has, that is what « and » step
            // through. Otherwise the lane is the queue, as before.
            const list = listOn(play);
            load(next, { play: true, lane: which, at, ...list });
            if (!list.list) loadLane(which);
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

  // Which row of a page's running order is the one playing. The list is server
  // rendered — fifty anchors and no component — so there is no state up here to
  // mark it with, and a fifty-row list with nothing showing where you are in it
  // is a list you have to remember your own place in. Written to the DOM rather
  // than rendered, for the same reason the list is not a component.
  useEffect(() => {
    const rows = document.querySelectorAll('[data-dock-list] [data-dock-play]');
    for (const row of rows) {
      let src = '';
      try {
        src = JSON.parse(row.getAttribute('data-dock-play') ?? '')?.src ?? '';
      } catch {
        /* a malformed row is simply never the current one */
      }
      const li = row.closest('li');
      if (!li) continue;
      li.classList.toggle('is-current', Boolean(track) && src === track.src);
    }
  }, [track]);

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

  const embed = embedded(track.kind);
  const video = track.kind === 'video' || embed;
  const list = upNext;
  const here = list.findIndex((entry) => entry.track?.src === track.src);
  const remaining = here === -1 ? list.length : list.length - here - 1;

  return (
    <aside
      className={`episode-player dock-player${video ? ' is-video' : ''}`}
      aria-label="Now playing"
    >
      <div className="episode-meta">
        <span className="eyebrow">{video ? 'Watching' : 'Listening'}</span>
        <strong title={track.title}>
          <a href={track.href}>{track.title}</a>
        </strong>
        {track.show && <span className="show">{track.show}</span>}
      </div>

      {embed ? (
        // Keyed on the source so stepping through a playlist replaces the frame
        // rather than re-pointing it: a cross-origin iframe whose src changes
        // pushes an entry onto the browser's history, and after three videos
        // the back button walks back through them instead of leaving the page.
        <iframe
          key={track.src}
          className="episode-video"
          src={embedSrc(track.src, autoplay)}
          title={track.title}
          loading="eager"
          // No referrerPolicy, deliberately — YouTube authorizes an embed by
          // its Referer and `no-referrer` makes every video fail with Error
          // 153. The same attribute list the in-page player uses, plus
          // autoplay, which is what makes pressing play out here start it.
          allow="accelerometer; autoplay; encrypted-media; picture-in-picture; fullscreen"
          sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
        />
      ) : video ? (
        <video
          key="video"
          ref={/** @type {any} */ (mediaRef)}
          className="episode-video"
          controls
          playsInline
          preload="metadata"
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

        {/* Where the running order came from. Calling a topic's playlist "your
            queue" and linking somewhere that does not contain it would be a
            lie about both. */}
        {pageList ? (
          <span className="dock-count">{remaining > 0 ? `${remaining} to go` : 'Last one'}</span>
        ) : (
          <a href={`/queue?lane=${lane}`} title="Your queue">
            Queue{remaining > 0 ? ` · ${remaining}` : ''}
          </a>
        )}

        <button type="button" onClick={stop} title="Close the player" aria-label="Close the player">
          <span aria-hidden="true">✕</span>
        </button>
      </div>
    </aside>
  );
}

/**
 * The running order a page has offered, if the control that was pressed is in one.
 *
 * A topic's watch playlist marks its list with `data-dock-list`, and pressing
 * play on the fourth video makes the other forty-nine the queue behind it.
 *
 * Read back off the rows rather than from a list written out a second time in
 * the marker attribute. Fifty tracks is a few tens of kilobytes and the rows
 * already carry every one of them — a second copy would be the same bytes
 * again, and two copies of a list are two chances for them to disagree. The
 * marker is therefore empty, and says only "these rows are a running order".
 *
 * Returned as the options `load` takes, or as nothing at all — the caller
 * spreads it, and an absent list means "use the reader's own queue", which is
 * what every other play control on the site wants.
 *
 * @param {Element|null} node the play control, or the element carrying the offer
 * @returns {{ list?: any[], fromPage?: boolean }}
 */
function listOn(node) {
  const holder = node?.closest?.('[data-dock-list]');
  if (!holder) return {};

  const list = [...holder.querySelectorAll('[data-dock-play]')]
    .map((el) => {
      try {
        return { track: JSON.parse(el.getAttribute('data-dock-play') ?? '') };
      } catch {
        // A malformed row is a bug in a page, not a reason to lose the list.
        return null;
      }
    })
    .filter((entry) => entry?.track?.src);

  return list.length > 0 ? { list, fromPage: true } : {};
}

/**
 * An embed's URL, told whether to start itself.
 *
 * YouTube and PeerTube both read `autoplay` off the query, which is the only
 * instruction either of them will take from out here. Built by URL rather than
 * by string so an embed that already carries a query keeps it.
 *
 * @param {string} src
 * @param {boolean} start
 * @returns {string}
 */
function embedSrc(src, start) {
  if (!start) return src;

  try {
    const url = new URL(src);
    url.searchParams.set('autoplay', '1');
    return url.toString();
  } catch {
    return src;
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
