'use client';

import { useEffect, useRef, useState } from 'react';

import { createScanner, scanUrls, sniffKind } from '../../lib/opml-scan.js';

/**
 * Feeds sent in one request.
 *
 * Small enough that no single request is ever the thing that fails — two
 * thousand entries is a few hundred kilobytes, which no proxy times out on and
 * no server has to hold — and large enough that a 700,000-entry catalogue is a
 * few hundred requests rather than a few hundred thousand.
 */
const BATCH = 2000;

/** Bytes read from the file at a time. Small enough that the bar moves visibly. */
const SLICE = 1 << 20;

/** How much of the file is kept as the "what you submitted" sample. */
const SAMPLE_CHARS = 50_000;

/**
 * URLs a pasted list may hold before it goes through the uploader too.
 *
 * A paste of a few hundred is fine as an ordinary form post and better as one:
 * a single URL redirects to the blog it added, which is the nicest thing that
 * happens on this page and is worth not losing. Past this it is a catalogue
 * wearing a textarea, and it wants the same treatment a file gets.
 */
const PASTE_DIRECT = 2_000;

/** Above this, a paste is too big to be worth counting before deciding. */
const PASTE_OBVIOUS = 100_000;

/** Attempts per batch before an upload gives up. */
const TRIES = 3;

/** Log lines kept on screen. */
const MAX_LINES = 40;

/**
 * The submit forms, and what they do when JavaScript is available.
 *
 * Uploading an OPML file used to be one multipart POST of the whole thing. That
 * works up to a few megabytes and then stops: a 117 MB catalogue is minutes of
 * upload with no feedback, the browser abandons the request before the server
 * has finished parsing it, and the submitter is left on a dead tab with no way
 * to tell whether anything was imported. Nothing about that is fixable at the
 * server end, because the failure is the size of the request itself.
 *
 * So the file is not sent. It is read here, a megabyte at a time, scanned for
 * the feeds it names, and those are posted in batches of two thousand — no
 * request in the whole import is more than a few hundred kilobytes, and any one
 * of them failing costs a retry rather than the upload. What the submitter gets
 * in exchange for the wait is the thing the old flow could never give them: a
 * bar that moves, a count that rises, and a log of what is going in.
 *
 * The forms are still forms. With JavaScript off both post exactly where they
 * always did, which is why the markup is a plain `action`/`method` pair and the
 * enhancement is one `onSubmit` handler — a submit that arrives before hydration
 * goes to the server rather than nowhere.
 *
 * @param {{ shared?: string }} props
 */
export default function Uploader({ shared = '' }) {
  /**
   * @type {[null | {
   *   phase: 'reading'|'saving'|'done'|'empty'|'error',
   *   name: string,
   *   percent: number,
   *   read: number,
   *   size: number,
   *   seen: number,
   *   queued: number,
   *   skipped: number,
   *   invalid: number,
   *   statusPath: string|null,
   *   error: string|null,
   *   lines: Array<{ at: number, text: string }>,
   * }, Function]}
   */
  const [run, setRun] = useState(null);
  const pasteRef = useRef(null);
  const fileRef = useRef(null);
  const emailRef = useRef(null);

  const busy = run?.phase === 'reading' || run?.phase === 'saving';

  /**
   * Drive one import from beginning to end.
   *
   * @param {{ kind: 'opml'|'list', source: File|string, size: number, name: string, email: string }} job
   */
  async function start(job) {
    /** @type {Array<{ at: number, text: string }>} */
    const lines = [];
    let state = {
      phase: /** @type {'reading'} */ ('reading'),
      kind: job.kind,
      name: job.name,
      percent: 0,
      read: 0,
      size: job.size,
      seen: 0,
      queued: 0,
      skipped: 0,
      invalid: 0,
      statusPath: null,
      error: null,
      lines,
    };

    const show = (patch) => {
      state = { ...state, ...patch };
      setRun(state);
    };

    const say = (text) => {
      lines.push({ at: Date.now(), text });
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    };

    show({});

    try {
      const sample = await sampleOf(job.source);

      // Decided from the head of the file rather than from the form it came
      // through: a reader that exports subscriptions as a plain list of URLs
      // named .txt is still a subscription list, and scanning it for `<outline>`
      // tags would find nothing and report an empty import.
      const kind = job.kind === 'opml' ? sniffKind({ name: job.name }, sample) : job.kind;
      show({ kind });

      const begun = await post('/api/submit/begin', { kind, sample, email: job.email });

      const submissionId = begun.submissionId;
      const batchSize = Math.min(BATCH, Number(begun.maxEntriesPerBatch) || BATCH);

      const scanner = createScanner(kind);
      /** @type {Array<{ url: string, title: string, siteUrl: string|null }>} */
      let pending = [];

      /**
       * Post whole batches, and on the last call whatever is left.
       *
       * `state.seen` is sent as the offset so the server can schedule this
       * batch after everything already queued rather than on top of it.
       *
       * @param {boolean} last
       */
      const flush = async (last) => {
        while (pending.length >= batchSize || (last && pending.length > 0)) {
          const slice = pending.slice(0, batchSize);
          pending = pending.slice(batchSize);

          const res = await post('/api/submit/batch', {
            submissionId,
            entries: slice,
            offset: state.seen,
          });

          say(
            `queued ${Number(res.queued).toLocaleString()} of ${slice.length.toLocaleString()}` +
              (res.skipped ? ` — ${Number(res.skipped).toLocaleString()} already here` : '') +
              (slice.at(-1) ? ` — ${hostOf(slice.at(-1).url)}` : ''),
          );

          show({
            seen: state.seen + slice.length,
            queued: state.queued + Number(res.queued ?? 0),
            skipped: state.skipped + Number(res.skipped ?? 0),
            invalid: state.invalid + Number(res.invalid ?? 0),
          });
        }
      };

      for await (const chunk of pieces(job.source)) {
        pending = pending.concat(scanner.push(chunk.text));

        const read = state.read + chunk.bytes;
        // Held at 99 until the file is actually finished. A bar that reaches a
        // hundred and then keeps working for another minute is the specific
        // thing that makes a wait feel broken.
        const percent = job.size > 0 ? Math.min(99, Math.floor((read / job.size) * 100)) : 0;

        show({ read, percent });
        await flush(false);
      }

      pending = pending.concat(scanner.end());
      show({ phase: 'saving', percent: 100, read: job.size });
      await flush(true);

      const done = await post('/api/submit/finish', {
        submissionId,
        email: job.email,
        invalid: state.invalid,
      });

      // Everything in the file was already in the directory. The status page
      // would report that honestly as nought per cent of nothing, which reads
      // as a failed import — so say it here instead, where it is plainly an
      // answer rather than an error.
      if (Number(done.queued) === 0) {
        show({ phase: 'empty', statusPath: done.statusPath ?? null });
        return;
      }

      show({ phase: 'done', statusPath: done.statusPath ?? null });
      window.location.href = done.statusPath ?? '/submit';
    } catch (err) {
      show({ phase: 'error', error: String(err?.message ?? err) });
    }
  }

  /**
   * @param {import('react').FormEvent<HTMLFormElement>} event
   */
  function onPaste(event) {
    const value = pasteRef.current?.value ?? '';

    // Under the threshold this is left entirely alone: the form posts, the
    // server resolves the URLs, and one URL still lands on the blog it added.
    if (value.length < PASTE_OBVIOUS && scanUrls(value).length <= PASTE_DIRECT) return;

    event.preventDefault();
    start({ kind: 'list', source: value, size: value.length, name: 'your list', email: '' });
  }

  /**
   * @param {import('react').FormEvent<HTMLFormElement>} event
   */
  function onUpload(event) {
    const file = fileRef.current?.files?.[0];

    // No file chosen: let the server answer that, rather than inventing a
    // second opinion about it here.
    if (!file || file.size === 0) return;

    event.preventDefault();
    start({
      kind: 'opml',
      source: file,
      size: file.size,
      name: file.name || 'your file',
      email: emailRef.current?.value ?? '',
    });
  }

  return (
    <>
      <form className="submit-box" action="/api/submit" method="post" onSubmit={onPaste}>
        <p className="eyebrow">One per line</p>
        <textarea
          ref={pasteRef}
          name="input"
          rows={5}
          defaultValue={shared}
          placeholder={'example.com\nanotherblog.net/feed.xml\nnetlabel.example/album.m3u'}
          aria-label="URLs to submit"
          required
          disabled={busy}
        />
        <div className="submit-actions">
          <button type="submit" disabled={busy}>
            Add to the directory
          </button>
        </div>
      </form>

      {run?.kind === 'list' && <Progress run={run} onReset={() => setRun(null)} />}

      <form
        className="submit-box"
        action="/api/submit"
        method="post"
        encType="multipart/form-data"
        onSubmit={onUpload}
      >
        <p className="eyebrow">Or upload an OPML file</p>
        <input
          ref={fileRef}
          type="file"
          name="opml"
          accept=".opml,.xml,.txt,text/xml,text/plain"
          aria-label="OPML file"
          disabled={busy}
        />
        <p className="hint">
          Any size. The file is read here in your browser and the feeds are sent a few thousand at a
          time, so a 100 MB subscription list imports without the upload ever timing out — you will
          see it go, and get a status page to watch the crawl.
        </p>
        <input
          ref={emailRef}
          type="email"
          name="email"
          placeholder="you@example.com — optional, we will email you when it finishes"
          aria-label="Email me when the import finishes"
          disabled={busy}
        />
        <div className="submit-actions">
          <button type="submit" disabled={busy}>
            Import subscriptions
          </button>
        </div>
      </form>

      {run?.kind === 'opml' && <Progress run={run} onReset={() => setRun(null)} />}
    </>
  );
}

/**
 * The import as it happens.
 *
 * Built from the same .live-* pieces the status pages use, deliberately: this
 * is the first half of one wait and `/submissions/<id>` is the second, and they
 * should not look like two different features.
 *
 * @param {{ run: object, onReset: () => void }} props
 */
function Progress({ run, onReset }) {
  const percent = Math.max(0, Math.min(100, Number(run.percent) || 0));
  const working = run.phase === 'reading' || run.phase === 'saving';
  const box = useRef(null);

  // Scrolled to on the one render where it appears.
  //
  // The panel sits under the form that starts it, which on a laptop is below
  // the fold — so pressing the button greyed it out and, as far as the screen
  // showed, did nothing else. That is the exact impression this whole change
  // exists to remove, and it would have been reintroduced by where the markup
  // happens to sit.
  useEffect(() => {
    box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  return (
    <section
      ref={box}
      className="live upload-live"
      aria-label="Upload progress"
      aria-busy={working}
    >
      <div className="live-head">
        <strong className="live-percent">{percent}%</strong>
        <span className="live-counts">
          {run.phase === 'error'
            ? 'stopped'
            : run.phase === 'reading'
              ? `${bytes(run.read)} of ${bytes(run.size)} read`
              : run.phase === 'saving'
                ? 'saving the last batch'
                : `${Number(run.queued).toLocaleString()} feeds queued`}
        </span>
      </div>

      <div
        className="live-bar"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Upload progress"
      >
        <div
          className={`live-fill${run.phase === 'done' || run.phase === 'empty' ? ' is-done' : working ? ' is-live' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <p className="live-busy">
        {run.phase === 'error' ? (
          <>
            {explain(run.error)} {Number(run.queued) > 0 && (
              <>
                {Number(run.queued).toLocaleString()} feeds were queued before it stopped
                {run.statusPath ? <> — <a href={run.statusPath}>see them</a></> : null}.{' '}
              </>
            )}
            Uploading the same file again picks up where this left off: anything already in the
            directory is skipped rather than added twice.
          </>
        ) : run.phase === 'empty' ? (
          <>
            Every one of the {Number(run.skipped).toLocaleString()} feeds in {run.name} is already
            in the directory, so there was nothing to add.
          </>
        ) : run.phase === 'done' ? (
          <>Queued. Taking you to the status page…</>
        ) : (
          <>
            Reading {run.name} — {Number(run.queued).toLocaleString()} queued
            {run.skipped > 0 ? `, ${Number(run.skipped).toLocaleString()} already here` : ''}. Leave
            this tab open until it finishes.
          </>
        )}
      </p>

      {run.lines.length > 0 && (
        <ol className="live-log">
          {run.lines.map((line, i) => (
            <li key={`${line.at}-${i}`}>
              <time>{clock(line.at)}</time> <span>{line.text}</span>
            </li>
          ))}
        </ol>
      )}

      {!working && run.phase !== 'done' && (
        <div className="submit-actions">
          <button type="button" onClick={onReset}>
            Start again
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * POST JSON, retrying the failures that are worth retrying.
 *
 * A batch is idempotent — the directory refuses a feed it already holds — so a
 * timeout or a dropped connection can simply be tried again, and on an import
 * of several hundred requests one of them going wrong is close to certain. A
 * refusal is not retried: the server has answered, and asking again would only
 * be rude about it.
 *
 * @param {string} url
 * @param {object} body
 * @returns {Promise<any>}
 */
async function post(url, body) {
  let last = null;

  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      last = err;
      await pause(attempt);
      continue;
    }

    if (res.ok) return res.json();

    const data = await res.json().catch(() => ({}));
    if (res.status < 500) throw new Error(data.error || `http-${res.status}`);

    last = new Error(data.error || `http-${res.status}`);
    await pause(attempt);
  }

  throw last ?? new Error('unreachable');
}

/**
 * @param {number} attempt
 * @returns {Promise<void>}
 */
function pause(attempt) {
  return new Promise((resolve) => setTimeout(resolve, attempt * 1500));
}

/**
 * The head of the upload, for the status page to name it by.
 *
 * @param {File|string} source
 * @returns {Promise<string>}
 */
async function sampleOf(source) {
  if (typeof source === 'string') return source.slice(0, SAMPLE_CHARS);
  // Four bytes per character is the worst UTF-8 can do, so this always has at
  // least SAMPLE_CHARS of text in it and usually far more, which is then cut.
  const head = await source.slice(0, SAMPLE_CHARS * 4).text();
  return head.slice(0, SAMPLE_CHARS);
}

/**
 * The upload, decoded a piece at a time.
 *
 * A slice of a file can begin or end in the middle of a UTF-8 character, so the
 * decoder is kept across pieces in streaming mode rather than made fresh for
 * each one. Decoding each slice independently would put a replacement character
 * wherever a boundary fell, which in a URL is a feed that no longer resolves.
 *
 * @param {File|string} source
 * @returns {AsyncGenerator<{ text: string, bytes: number }>}
 */
async function* pieces(source) {
  if (typeof source === 'string') {
    for (let at = 0; at < source.length; at += SLICE) {
      const text = source.slice(at, at + SLICE);
      yield { text, bytes: text.length };
    }
    return;
  }

  const decoder = new TextDecoder();

  for (let at = 0; at < source.size; at += SLICE) {
    const blob = source.slice(at, Math.min(at + SLICE, source.size));
    const buffer = await blob.arrayBuffer();
    yield { text: decoder.decode(buffer, { stream: true }), bytes: blob.size };
  }

  const tail = decoder.decode();
  if (tail) yield { text: tail, bytes: 0 };
}

/**
 * @param {string|null} error
 * @returns {string}
 */
function explain(error) {
  if (error === 'rate-limited') return 'That is too many submissions from here in one hour.';
  if (error === 'too-many-feeds') return 'That is more feeds than one import may add.';
  if (error === 'expired') return 'The import took longer than a submission stays open.';
  if (error === 'not-yours') return 'That import belongs to a different connection.';
  return 'The upload stopped before it finished.';
}

/**
 * @param {number} n
 * @returns {string}
 */
function bytes(n) {
  const value = Number(n) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url).slice(0, 40);
  }
}

/**
 * @param {number} at
 * @returns {string}
 */
function clock(at) {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
