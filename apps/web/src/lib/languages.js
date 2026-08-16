import { translations } from '@rssamplifier/db';
import { READER_LANGUAGES, offeredLanguages } from '@rssamplifier/translate';

import { db } from './db.js';

/**
 * Which languages the reader is offered, cached in the process.
 *
 * The answer is a group-by over every feed in the directory — ~47k rows — and
 * it changes on the timescale of the crawler discovering a new corner of the
 * web, not on the timescale of a page view. Recomputing it per request would
 * put a full aggregate on the critical path of the reader for a list that is
 * the same all day.
 *
 * The cache is per process and dies with it, which is the right lifetime here:
 * a deploy or a restart is exactly when it is worth looking again.
 */

/** How long a computed list is trusted. */
const TTL_MS = 60 * 60 * 1000;

/** @type {{ languages: string[], at: number }|null} */
let cache = null;

/**
 * The language codes to show in the bar: the reader languages first, then
 * whatever else the directory declares enough of to be worth a slot.
 *
 * Falls back to the reader languages if the query fails. Losing the aggregate
 * costs the bar its long tail, not the bar itself — and a reader page that 500s
 * is not a feature at all.
 *
 * @returns {Promise<string[]>}
 */
export async function popularLanguages() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.languages;

  try {
    const counts = await translations.languageCounts(db());
    const languages = offeredLanguages(counts, { always: READER_LANGUAGES });
    cache = { languages, at: Date.now() };
    return languages;
  } catch {
    return [...READER_LANGUAGES];
  }
}
