import { translations } from '@rssamplifier/db';

import { normalizeLang } from './src/languages.js';
import { translatePost } from './src/translate.js';

export {
  BASE_LANGUAGE,
  MAX_OFFERED,
  languageName,
  normalizeLang,
  offeredLanguages,
} from './src/languages.js';
export { MODEL, MAX_SOURCE_CHARS, translatePost } from './src/translate.js';

/**
 * Paid translations one reader may trigger in a UTC day.
 *
 * Stops one account walking the ~47k-feed catalogue. Sized so an enthusiastic
 * reader never notices it and a script hits it in under a minute.
 */
export const DEFAULT_DAILY_PER_USER = 60;

/**
 * Paid translations everybody together may trigger in a UTC day.
 *
 * This is the number that actually bounds the bill. Sign-up is a magic link to
 * any address, so an attacker can mint accounts for free and the per-user limit
 * alone would only decide how many accounts they need. At roughly a cent a call
 * this ceiling is a low-tens-of-dollars worst case for a day of sustained
 * abuse — and a deploy away from being lowered.
 */
export const DEFAULT_DAILY_TOTAL = 1000;

/**
 * The configured ceilings.
 *
 * Read through a non-literal property access for the same reason as every other
 * env lookup here: Next inlines `process.env.FOO` at build time, and a limit
 * baked into the image at build time is not a limit anybody can turn down in a
 * hurry. A value that is not a positive number falls back to the default rather
 * than to "no limit" — a typo in a Railway variable must not uncap spending.
 *
 * @returns {{ perUser: number, total: number }}
 */
export function limits() {
  const env = process.env;
  return {
    perUser: positive(env['TRANSLATE_DAILY_PER_USER'], DEFAULT_DAILY_PER_USER),
    total: positive(env['TRANSLATE_DAILY_TOTAL'], DEFAULT_DAILY_TOTAL),
  };
}

/**
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function positive(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * A post in the reader's language: from cache, or translated and cached now.
 *
 * The first reader to ask for a given post in a given language pays the API
 * call and everybody after them reads the row it wrote. Two readers arriving at
 * the same instant will both translate and the second write wins — a wasted
 * call, not a wrong answer, and cheaper than a lock.
 *
 * Only a cache miss can cost money, so only a cache miss is metered. Reading a
 * translation somebody else already paid for is free and stays free however
 * much of it a reader does.
 *
 * `translation: null` covers every way there is nothing to show — the post is
 * already in that language, no API key is configured, the model declined — and
 * every one of them is a page that still renders the original. `limited` is
 * the one case worth telling the reader about, because it is the only one that
 * will fix itself tomorrow.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{
 *   itemId: string,
 *   title: string,
 *   summary?: string|null,
 *   targetLang: string,
 *   sourceLang?: string|null,
 *   userId?: string|null,
 *   now?: Date,
 * }} input
 * @returns {Promise<{
 *   translation: { title: string, summary: string|null, sourceLang: string|null, cached: boolean }|null,
 *   limited: boolean,
 * }>}
 */
export async function ensureTranslation(db, input) {
  const target = normalizeLang(input.targetLang);
  if (!target) return none();

  const source = normalizeLang(input.sourceLang);
  // Translating German into German is an API call whose correct answer is the
  // input. Only skip when the feed actually declares a language — an unlabelled
  // feed gets translated, and the model reports what it found.
  if (source && source === target) return none();

  const cached = await translations.translationFor(db, input.itemId, target);
  if (cached) {
    return {
      translation: {
        title: String(cached.title),
        summary: cached.summary === null ? null : String(cached.summary),
        sourceLang: cached.source_lang === null ? null : String(cached.source_lang),
        cached: true,
      },
      limited: false,
    };
  }

  // Past here, every path spends money. Anonymous callers never get this far:
  // there is nobody to meter, so there is nothing to bill.
  const userId = input.userId ? String(input.userId) : null;
  if (!userId) return none();

  const day = translations.usageDay(input.now);
  const { perUser, total } = limits();

  const [mine, everyone] = await Promise.all([
    translations.usageForUser(db, userId, day),
    translations.usageForDay(db, day),
  ]);

  if (mine >= perUser || everyone >= total) return { translation: null, limited: true };

  // Charged before the call, not after. A request that fails still consumed an
  // attempt, and metering the successes only would leave a free retry loop for
  // anyone who can make the model fail — which is the cheapest thing in the
  // world to arrange. An honest reader loses one of sixty to a transient error.
  await translations.recordUsage(db, userId, day);

  let fresh;
  try {
    fresh = await translatePost({
      title: input.title,
      summary: input.summary,
      targetLang: target,
      sourceLang: source,
    });
  } catch {
    // Rate limits, timeouts, a revoked key: all of them mean "show the
    // original", and none of them should reach the reader as an error page.
    return none();
  }

  if (!fresh) return none();

  await translations.saveTranslation(db, {
    itemId: input.itemId,
    lang: target,
    title: fresh.title,
    summary: fresh.summary,
    model: fresh.model,
    sourceLang: fresh.sourceLang ?? source,
  });

  return {
    translation: {
      title: fresh.title,
      summary: fresh.summary,
      sourceLang: fresh.sourceLang ?? source,
      cached: false,
    },
    limited: false,
  };
}

/**
 * @returns {{ translation: null, limited: false }}
 */
function none() {
  return { translation: null, limited: false };
}
