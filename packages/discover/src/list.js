import { normalizeUrl } from '@rssamplifier/feed';

/**
 * Candidates from a plain-text list of URLs.
 *
 * This is the format the small-web lists are kept in: one URL per line, with
 * an optional `# title …` comment after it. Deliberately tolerant — these are
 * files people edit by hand, so blank lines, stray whitespace and full-line
 * comments are all normal rather than malformed.
 */

/** Longest list body accepted, so one enormous file cannot exhaust memory. */
const MAX_BYTES = 8_000_000;

/**
 * Read the URLs out of a list.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function parseList(body) {
  const urls = [];
  const seen = new Set();

  for (const rawLine of String(body ?? '').split('\n')) {
    // Everything after the first # is a human note about the entry.
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const url = normalizeUrl(line);
    if (!url || seen.has(url)) continue;

    seen.add(url);
    urls.push(url);
  }

  return urls;
}

/**
 * Fetch a list and return its URLs.
 *
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, limit?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<string[]>}
 */
export async function candidatesFromList(url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;

  const response = await fetchImpl(url, {
    headers: { accept: 'text/plain', 'user-agent': USER_AGENT },
    signal: opts.signal,
  });

  if (!response.ok) throw new Error(`list fetch failed: ${response.status}`);

  const body = await response.text();
  if (body.length > MAX_BYTES) throw new Error('list is implausibly large');

  const urls = parseList(body);
  return opts.limit ? urls.slice(0, opts.limit) : urls;
}

/**
 * Who we say we are when fetching somebody else's list.
 *
 * A discovery crawler that does not identify itself is one a maintainer cannot
 * ask to stop, which is the sort of thing that gets a project blocked.
 */
export const USER_AGENT =
  'rssamplifier-discovery/1.0 (+https://rssamplifier.com/about; feed directory)';
