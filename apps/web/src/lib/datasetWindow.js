import { dataset } from '@rssamplifier/db';

/**
 * The four-hour clock the corpus is cut on.
 *
 * Deliberately free of any Next import, and that is the whole reason it is a
 * file of its own rather than the top of `dataset.js`. Boundary arithmetic is
 * the part of this feature most worth testing — an off-by-one here is a gap in
 * somebody's corpus that neither side would notice for months — and the gate
 * beside it reaches `next/headers` through `currentUser`, which cannot be
 * imported by `node --test`. Splitting them means the arithmetic is tested and
 * the gate is not, rather than neither being.
 *
 * ## Why the corpus is cut on a boundary rather than on "now"
 *
 * A buyer training on this data runs the same pull on a timer, for months. If
 * each pull meant "everything since the moment you last asked", then their
 * clock, our clock and the crawler's insert latency would all have to agree for
 * the corpus to have no gaps and no duplicates — and they never will. A row
 * whose `created_at` is a second before the request but which commits a second
 * after it is invisible for ever, and nothing on either side would notice.
 *
 * Slicing on fixed UTC boundaries removes the question. `[00:00, 04:00)` is the
 * same set of rows whoever asks and whenever they ask, so a pipeline that walks
 * boundaries in order provably sees every row exactly once. It also makes a
 * failed pull retryable without reasoning about what was already taken, and
 * makes two callers comparing notes able to say they have the same artifact.
 *
 * ## Why only closed windows are served
 *
 * The window containing the present is still filling. Serving it would hand back
 * a partial slice under an identifier that promises completeness, and the buyer
 * would have no way to tell — the next pull of the same window would silently
 * disagree with the last. So the newest window on offer is always the most
 * recently *closed* one, and the manifest says when the next opens.
 */

/** Milliseconds in one slice. Derived, so the two constants cannot drift. */
const WINDOW_MS = dataset.WINDOW_HOURS * 60 * 60 * 1000;

/**
 * The start of the window a moment falls in.
 *
 * Floors against the Unix epoch rather than against midnight. The epoch is a
 * multiple of four hours, so the two happen to agree today — but only the epoch
 * keeps agreeing if `WINDOW_HOURS` is ever changed to something that does not
 * divide 24, and a boundary scheme that quietly breaks on a config change is not
 * a contract.
 *
 * @param {number|Date} [at]
 * @returns {string} ISO-8601, to the second, matching how the database stores time
 */
export function windowStart(at = Date.now()) {
  const ms = at instanceof Date ? at.getTime() : at;
  return new Date(Math.floor(ms / WINDOW_MS) * WINDOW_MS).toISOString();
}

/**
 * The window after this one.
 *
 * @param {string} start
 * @returns {string}
 */
export function windowEnd(start) {
  return new Date(Date.parse(start) + WINDOW_MS).toISOString();
}

/**
 * The newest window that has finished filling.
 *
 * @param {number} [now]
 * @returns {string}
 */
export function latestClosedWindow(now = Date.now()) {
  return windowStart(now - WINDOW_MS);
}

/**
 * Read a requested window, or fall back to the newest closed one.
 *
 * Refuses rather than rounds. A caller who asks for `13:37` has a bug in their
 * boundary arithmetic, and quietly serving them the 12:00 slice under their own
 * label means their corpus is mislabelled in a way that only shows up much later
 * as duplicated rows. Told plainly, they fix it on the first run.
 *
 * @param {string|null} requested
 * @param {number} [now]
 * @returns {{ ok: true, start: string, end: string } | { ok: false, error: string, detail: string }}
 */
export function resolveWindow(requested, now = Date.now()) {
  const newest = latestClosedWindow(now);
  if (!requested) return { ok: true, start: newest, end: windowEnd(newest) };

  const ms = Date.parse(requested);
  if (!Number.isFinite(ms)) {
    return {
      ok: false,
      error: 'bad-window',
      detail: `"${requested}" is not a timestamp. Pass a window boundary in ISO-8601, or omit it for the newest closed window.`,
    };
  }

  const aligned = windowStart(ms);
  if (aligned !== new Date(ms).toISOString()) {
    return {
      ok: false,
      error: 'unaligned-window',
      detail: `Windows are ${dataset.WINDOW_HOURS}-hourly and start on the boundary. The window containing that moment starts at ${aligned}.`,
    };
  }

  if (Date.parse(aligned) > Date.parse(newest)) {
    return {
      ok: false,
      error: 'window-not-closed',
      detail: `That window has not finished filling. The newest complete one is ${newest}.`,
    };
  }

  return { ok: true, start: aligned, end: windowEnd(aligned) };
}

/**
 * The start of the current UTC day, for the full-dump allowance.
 *
 * @param {number} [now]
 * @returns {string}
 */
export function startOfUtcDay(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

