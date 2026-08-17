'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { explain } from '../lib/reasons.js';

/** Log lines kept in the DOM. Older ones scroll out of history, not just view. */
const MAX_LINES = 300;

/**
 * A queue draining, shown as it happens.
 *
 * Both status pages used to be a table of numbers that changed if you reloaded,
 * which left the honest impression that nothing was happening. The work was
 * always live; only the page was not. This subscribes to the run's event stream
 * and shows the two things that make a wait legible — how far along it is, and
 * what it is doing right now.
 *
 * Progressive enhancement is the whole design. The server renders the same
 * numbers into the bar first, so a reader with no JavaScript sees a filled bar
 * and a correct total; this only ever makes it move. When the stream ends it
 * asks the server component to re-render, so the finished lists below arrive
 * without the reader touching anything.
 *
 * `lines` arrives already rendered by the server so that a run which finished
 * hours ago still shows its log. Without it the only source of lines is the
 * stream, and a finished run opens no stream — the reader most likely to want
 * the history would be the one guaranteed not to get it.
 *
 * @param {{ src: string, initial: { percent: number, settled: number, total: number, done: boolean }, lines?: object[], unit: string, verb: string }} props
 */
export default function LiveProgress({ src, initial, lines: seed = [], unit, verb }) {
  const router = useRouter();
  const [progress, setProgress] = useState(initial);
  const [lines, setLines] = useState(seed);
  const [live, setLive] = useState(false);
  const logRef = useRef(null);
  const pinned = useRef(true);

  useEffect(() => {
    if (initial.done) return undefined;

    const source = new EventSource(src);

    source.addEventListener('open', () => setLive(true));

    source.addEventListener('progress', (event) => {
      try {
        setProgress(JSON.parse(event.data));
      } catch {
        // A malformed frame is not worth breaking the page over.
      }
    });

    source.addEventListener('log', (event) => {
      try {
        const entry = JSON.parse(event.data);
        setLines((prev) => [...prev, entry].slice(-MAX_LINES));
      } catch {
        // As above.
      }
    });

    source.addEventListener('end', (event) => {
      let reason = 'complete';
      try {
        reason = JSON.parse(event.data)?.reason ?? 'complete';
      } catch {
        // Keep the default.
      }

      // 'reconnect' is the server retiring a long-lived connection; EventSource
      // opens a new one by itself and the cursor means nothing is missed. Only
      // a genuine finish should stop the stream and refresh the page under it.
      if (reason === 'reconnect') return;

      source.close();
      setLive(false);
      router.refresh();
    });

    source.addEventListener('error', () => setLive(false));

    return () => source.close();
  }, [src, initial.done, router]);

  // Follow the tail, unless the reader has scrolled up to read something. A log
  // that yanks you back to the bottom mid-sentence is worse than no log.
  useEffect(() => {
    const el = logRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));

  return (
    <section className="live" aria-label="Progress">
      <div className="live-head">
        <strong className="live-percent">{percent}%</strong>
        <span className="live-counts">
          {Number(progress.settled).toLocaleString()} of {Number(progress.total).toLocaleString()}{' '}
          {unit}
          {progress.done ? ' — finished' : live ? ' — working' : ''}
        </span>
      </div>

      <div
        className="live-bar"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${verb} progress`}
      >
        <div
          className={`live-fill${progress.done ? ' is-done' : live ? ' is-live' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {lines.length > 0 && (
        <ol
          className="live-log"
          ref={logRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {lines.map((line, i) => (
            <li key={`${line.at}-${line.subject}-${i}`} className={`is-${toneOf(line)}`}>
              <time>{clock(line.at)}</time> <span>{describe(line)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Good news, bad news, or neither — the log's only styling decision.
 *
 * @param {{ status: string }} line
 * @returns {'good'|'bad'|'plain'}
 */
function toneOf(line) {
  if (line.status === 'accepted' || line.status === 'active' || line.status === 'searched') {
    return 'good';
  }
  if (line.status === 'error' || line.status === 'failed' || line.status === 'dead') return 'bad';
  return 'plain';
}

/**
 * One event, as one line of English.
 *
 * @param {{ kind: string, subject: string, status: string, detail: string|null, slug: string|null, amount: number|null }} line
 * @returns {string}
 */
function describe(line) {
  if (line.kind === 'keyword') {
    if (line.status === 'failed') {
      return `“${line.subject}” could not be searched — ${line.detail ?? 'unknown'}`;
    }
    const n = Number(line.amount ?? 0);
    return `searched “${line.subject}” — ${n.toLocaleString()} ${n === 1 ? 'site' : 'sites'} to check`;
  }

  if (line.kind === 'feed') {
    if (line.status === 'active') {
      const n = Number(line.amount ?? 0);
      return `crawled ${line.subject} — ${n.toLocaleString()} ${n === 1 ? 'post' : 'posts'}`;
    }
    return `${line.subject} could not be crawled — ${line.detail ?? 'unknown'}`;
  }

  if (line.status === 'accepted') {
    const score = line.amount == null ? '' : ` (scored ${line.amount})`;
    return `added ${line.subject}${score}`;
  }

  return `skipped ${line.subject} — ${explain(line.detail)}`;
}

/**
 * Just the time of day: the date is always today and a log line has no room.
 *
 * @param {string} iso
 * @returns {string}
 */
function clock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
