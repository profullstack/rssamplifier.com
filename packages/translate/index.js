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
 * A post in the reader's language: from cache, or translated and cached now.
 *
 * The first reader to ask for a given post in a given language pays the API
 * call and everybody after them reads the row it wrote. Two readers arriving at
 * the same instant will both translate and the second write wins — a wasted
 * call, not a wrong answer, and cheaper than a lock.
 *
 * Returns null for "no translation, show the original", which covers the post
 * already being in that language, a missing API key, and the model declining.
 * Every one of those is a page that still renders.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{
 *   itemId: string,
 *   title: string,
 *   summary?: string|null,
 *   targetLang: string,
 *   sourceLang?: string|null,
 * }} input
 * @returns {Promise<{ title: string, summary: string|null, sourceLang: string|null, cached: boolean }|null>}
 */
export async function ensureTranslation(db, input) {
  const target = normalizeLang(input.targetLang);
  if (!target) return null;

  const source = normalizeLang(input.sourceLang);
  // Translating German into German is an API call whose correct answer is the
  // input. Only skip when the feed actually declares a language — an unlabelled
  // feed gets translated, and the model reports what it found.
  if (source && source === target) return null;

  const cached = await translations.translationFor(db, input.itemId, target);
  if (cached) {
    return {
      title: String(cached.title),
      summary: cached.summary === null ? null : String(cached.summary),
      sourceLang: cached.source_lang === null ? null : String(cached.source_lang),
      cached: true,
    };
  }

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
    return null;
  }

  if (!fresh) return null;

  await translations.saveTranslation(db, {
    itemId: input.itemId,
    lang: target,
    title: fresh.title,
    summary: fresh.summary,
    model: fresh.model,
    sourceLang: fresh.sourceLang ?? source,
  });

  return {
    title: fresh.title,
    summary: fresh.summary,
    sourceLang: fresh.sourceLang ?? source,
    cached: false,
  };
}
