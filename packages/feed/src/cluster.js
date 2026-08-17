import { createHash } from 'node:crypto';

/**
 * Recognising one story told by many feeds.
 *
 * A directory this size carries the same announcement dozens of times: the
 * vendor blog, four newsletters that reprint it, and every aggregator in the
 * topic. A river built out of that shows a reader one story and calls it
 * twelve, which is the single thing that makes topic feeds unreadable.
 *
 * The key is computed once, when the item is stored, and grouping is then a
 * string comparison. Nothing here is a similarity score and nothing calls a
 * model: at ingest scale the only affordable question is "is this the same
 * headline", and it turns out to answer most of the problem, because
 * syndication copies headlines verbatim.
 *
 * The bias is deliberate: it is far worse to merge two different posts than to
 * miss that two are the same. A missed duplicate is a slightly repetitive feed;
 * a wrong merge silently hides somebody's writing.
 */

/**
 * Words carried by so many headlines that they cannot help identify one.
 *
 * Kept short on purpose. Every word removed here makes two different posts
 * likelier to collide, so this list earns its place only on words that are
 * pure grammar.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'by',
  'is',
  'are',
  'was',
  'were',
  'be',
  'as',
  'it',
  'its',
  'this',
  'that',
  'how',
  'why',
  'what',
]);

/**
 * Fewest meaningful words a title needs before it may be grouped at all.
 *
 * This is the whole safety margin. "Weeknotes", "Links", "Monthly update" and
 * "Hello world" are titles that hundreds of unrelated blogs use, and clustering
 * on them would merge the small web into a single post. Below this threshold
 * the item gets no key and is never grouped with anything.
 */
const MIN_WORDS = 4;

/**
 * The significant words of a title, in order.
 *
 * @param {string} title
 * @returns {string[]}
 */
export function titleWords(title) {
  return String(title ?? '')
    .toLowerCase()
    // Unicode-aware: a headline in Greek or Japanese must not be reduced to
    // nothing and then silently treated as untitled.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w));
}

/**
 * A grouping key for one item, or null when it must never be grouped.
 *
 * @param {string} title
 * @returns {string|null}
 */
export function clusterKey(title) {
  const words = titleWords(title);
  if (words.length < MIN_WORDS) return null;

  // Sorted, so that "Rust 2.0 released" and "Released: Rust 2.0" agree. Word
  // order is the part of a headline that syndication is most likely to change,
  // and the set of words is what actually identifies the story.
  const canonical = [...words].sort().join(' ');
  return createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Collapse a list of items so each story appears once.
 *
 * Order is preserved and the first occurrence wins, so a caller that sorted
 * newest-first keeps the newest telling of a story. Items with no key are never
 * merged — they are passed through untouched, which is the safe direction.
 *
 * The survivor carries `duplicates`: how many other feeds ran the same story.
 * That number is the interesting part of deduplication, so it is kept rather
 * than thrown away — "also in 6 feeds" is worth showing.
 *
 * @template {{ cluster_key?: string|null, title?: string }} T
 * @param {T[]} rows
 * @returns {(T & { duplicates: number })[]}
 */
export function dedupeItems(rows) {
  /** @type {Map<string, any>} */
  const byKey = new Map();
  /** @type {any[]} */
  const out = [];

  for (const row of rows ?? []) {
    // Fall back to computing the key when the column has not been backfilled
    // yet, so grouping works on old rows before the worker reaches them.
    const key = row.cluster_key ?? clusterKey(row.title ?? '');

    if (!key) {
      out.push({ ...row, duplicates: 0 });
      continue;
    }

    const seen = byKey.get(key);
    if (seen) {
      seen.duplicates += 1;
      continue;
    }

    const kept = { ...row, duplicates: 0 };
    byKey.set(key, kept);
    out.push(kept);
  }

  return out;
}
