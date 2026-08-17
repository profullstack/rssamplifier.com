'use client';

import { useEffect, useRef, useState } from 'react';

import { describe, tone } from '../../lib/crawlLog.js';

/**
 * Lines kept in the DOM.
 *
 * The crawler produces one per feed, so an hour of watching is thousands of
 * them; a log view that keeps every line eventually becomes a page that cannot
 * scroll. The stream is the durable-ish copy — `?format=text` reads the same
 * rows — so this is a window, not a buffer.
 */
const MAX_LINES = 400;

/**
 * The crawler's log, as it is written.
 *
 * The rest of /crawlstats answers "is it keeping up?" with counts that are true
 * the moment the page renders. This answers the question those counts always
 * raise next: what is it doing *right now*. It is the same information the
 * poller writes to its own stdout, which until now was readable only inside
 * Railway.
 *
 * Progressive enhancement, like the rest of the site: the server renders the
 * most recent lines into the list, so a reader with no JavaScript still gets a
 * log — one that is a minute old rather than live. This only makes it move.
 *
 * @param {{ src: string, lines?: object[] }} props
 */
export default function CrawlLog({ src, lines: seed = [] }) {
  const [lines, setLines] = useState(seed);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [failuresOnly, setFailuresOnly] = useState(false);

  // Where to resume from. Kept in a ref rather than in state because reopening
  // the stream must not be a render: the cursor changes on every line.
  const cursor = useRef(Number(seed.at(-1)?.id ?? 0));
  const logRef = useRef(null);
  const pinned = useRef(true);

  useEffect(() => {
    if (paused) return undefined;

    // Resume from the last line already on the page. Without this the whole
    // visible history reappears underneath itself on every reconnect.
    const url = cursor.current
      ? `${src}${src.includes('?') ? '&' : '?'}since=${cursor.current}`
      : src;
    const source = new EventSource(url);

    source.addEventListener('open', () => setLive(true));

    source.addEventListener('log', (event) => {
      try {
        const entry = JSON.parse(event.data);

        // The server issues each frame's id and the browser replays it as
        // Last-Event-ID after a dropped connection, so duplicates should be
        // impossible. Cheap to enforce anyway: one repeated line in a log is
        // indistinguishable from the crawler doing something twice.
        if (Number(entry.id) <= cursor.current) return;
        cursor.current = Number(entry.id);

        setLines((prev) => [...prev, entry].slice(-MAX_LINES));
        setLive(true);
      } catch {
        // A malformed frame is not worth breaking the page over.
      }
    });

    // A stream that has been quiet for a while says so, which is how we know
    // the connection is alive and the crawler is merely idle.
    source.addEventListener('ping', () => setLive(true));

    source.addEventListener('error', () => setLive(false));

    return () => {
      source.close();
      setLive(false);
    };
  }, [src, paused]);

  // Follow the tail, unless the reader has scrolled up to read something. A log
  // that yanks you back to the bottom mid-sentence is worse than no log.
  useEffect(() => {
    const el = logRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const shown = failuresOnly ? lines.filter((l) => l.status === 'error') : lines;

  return (
    <section className="crawl-log-panel" aria-label="Crawler log">
      <div className="crawl-log-head">
        <span className={`crawl-log-state${live && !paused ? ' is-live' : ''}`}>
          {paused ? 'Paused' : live ? 'Live' : 'Connecting…'}
        </span>

        <span className="crawl-log-count">
          {shown.length.toLocaleString('en-US')} {shown.length === 1 ? 'line' : 'lines'}
          {failuresOnly && ` of ${lines.length.toLocaleString('en-US')}`}
        </span>

        <label className="crawl-log-filter">
          <input
            type="checkbox"
            checked={failuresOnly}
            onChange={(event) => setFailuresOnly(event.currentTarget.checked)}
          />{' '}
          failures only
        </label>

        {/*
         * Pause closes the stream and resume reopens it from the cursor, rather
         * than buffering behind the reader's back: nothing is missed either way,
         * and this way a tab left paused is not a connection left open.
         */}
        <button type="button" className="crawl-log-button" onClick={() => setPaused((p) => !p)}>
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="crawl-log-empty">
          {failuresOnly ? 'Nothing has failed in the visible log.' : 'Waiting for the crawler…'}
        </p>
      ) : (
        <ol
          className="live-log crawl-log"
          ref={logRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {shown.map((entry) => (
            <li key={entry.id} className={`is-${tone(entry)}`}>
              <time dateTime={entry.at}>{clock(entry.at)}</time>
              <span>
                {entry.slug ? (
                  // A failing feed in the log is the start of an investigation,
                  // and its page is where that investigation goes next.
                  <a href={`/${entry.slug}`}>{describe(entry)}</a>
                ) : (
                  describe(entry)
                )}
                {entry.ms != null && <em className="crawl-log-ms"> {formatMs(entry.ms)}</em>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Just the time of day: every line is from the last few minutes and a log line
 * has no room for a date.
 *
 * @param {string} iso
 * @returns {string}
 */
function clock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatMs(ms) {
  const n = Number(ms);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}
