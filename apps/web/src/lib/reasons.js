/**
 * Why a site was turned down, in words rather than codes.
 *
 * Shared because the same verdict is now rendered twice: once by the server
 * when the page loads and once by the live log as it arrives. Two copies of
 * this map would drift, and the drift would show up as the same rejection
 * described two different ways on one screen.
 */
export const REASONS = {
  'already-indexed': 'already in the directory',
  'comments-feed': 'a comment feed, not a blog',
  'partial-feed': 'a tag or category feed',
  'too-few-items': 'too few entries',
  abandoned: 'nothing posted in over 18 months',
  'duplicate-titles': 'every entry has the same title',
  'unlinked-items': 'entries link nowhere',
  undated: 'no dates on any entry',
  untitled: 'no title',
  'low-score': 'did not score high enough',
  'no-feed-found': 'no feed on the site',
  timeout: 'site did not respond',
  'fetch-failed': 'site could not be reached',
  'blocked-host': 'not a public address',
  // Emitted by the checker but never given words until the log started showing
  // rejections one by one, where a bare code is the most common thing on screen.
  'off-topic': 'not about what was searched for',
  'blocked-redirect': 'redirected somewhere we will not follow',
  'invalid-url': 'not a usable address',
};

/** Provider errors that stop a whole run, in words a person can act on. */
export const RUN_ERRORS = {
  'no-api-key': 'Search is not configured on this server, so nothing could be searched.',
  'bad-api-key': 'The search provider rejected our credentials. Nothing could be searched.',
  'quota-exhausted':
    'The month’s search credits are spent. Remaining keywords stay queued and will run once the plan resets.',
  'rate-limited': 'The search provider is rate-limiting us. Remaining keywords stay queued.',
};

/**
 * Turn a stored reason — a JSON array of codes, or a single code — into prose.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function explain(raw) {
  const value = String(raw ?? '');
  if (!value) return 'unknown';

  let codes = [value];
  if (value.startsWith('[')) {
    try {
      codes = JSON.parse(value);
    } catch {
      codes = [value];
    }
  }

  const words = codes.map((code) => REASONS[code] ?? httpWords(String(code)));
  return words.length > 0 ? words.join(', ') : 'unknown';
}

/**
 * An HTTP status the site returned, said out loud.
 *
 * These cannot go in the map because the code carries the number: `http-403`
 * and `http-503` are separate reasons and both are common.
 *
 * @param {string} code
 * @returns {string}
 */
function httpWords(code) {
  const match = /^http-(\d{3})$/.exec(code);
  if (!match) return code;

  const status = Number(match[1]);
  if (status === 403) return 'site refused us (403)';
  if (status === 404) return 'page not found (404)';
  if (status === 429) return 'site rate-limited us (429)';
  if (status >= 500) return `site is erroring (${status})`;
  return `site answered ${status}`;
}
