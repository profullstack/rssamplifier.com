import { translations } from '@rssamplifier/db';
import { sanitizeHtml, textLength } from '@rssamplifier/feed';

import { normalizeLang } from './src/languages.js';
import { MIN_ARTICLE_CHARS, translateArticle, translatePost } from './src/translate.js';

export {
  BASE_LANGUAGE,
  MAX_OFFERED,
  READER_LANGUAGES,
  languageName,
  normalizeLang,
  offeredLanguages,
} from './src/languages.js';
export {
  MODEL,
  MAX_SOURCE_CHARS,
  MAX_ARTICLE_CHARS,
  MIN_ARTICLE_CHARS,
  translatePost,
  translateArticle,
} from './src/translate.js';

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
 * alone would only decide how many accounts they need.
 *
 * Read the ceiling as calls, not as money: the two are no longer the same
 * thing. A headline-and-summary translation caps at 4k output tokens, but a
 * whole-article one caps at ARTICLE_MAX_TOKENS (32k) over as much as
 * MAX_ARTICLE_CHARS (60k) of input, so the expensive kind costs on the order of
 * ten times the cheap kind and one unit of this budget no longer means one
 * roughly-fixed price. A day of sustained abuse against the article path is
 * therefore a low-hundreds-of-dollars worst case rather than the low tens this
 * number was originally sized for.
 *
 * Lower `TRANSLATE_DAILY_TOTAL` to bound it harder — it takes effect without a
 * deploy. Making the ledger charge an article more units than a headline would
 * fix this properly, and is the obvious next step if the article path stays.
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
 *   contentHtml?: string|null,
 *   targetLang: string,
 *   sourceLang?: string|null,
 *   userId?: string|null,
 *   now?: Date,
 * }} input
 * @returns {Promise<{
 *   translation: {
 *     title: string, summary: string|null, contentHtml: string|null,
 *     truncated: boolean, sourceLang: string|null, cached: boolean
 *   }|null,
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
  // A cached row with a body is the finished article. One without — written
  // before articles were translated, or for a feed that had no body to
  // translate — is not re-translated on the strength of that alone: the
  // caller says whether a body is available to work from.
  if (cached && (cached.content_html || !input.contentHtml)) {
    return {
      translation: {
        title: String(cached.title),
        summary: cached.summary === null ? null : String(cached.summary),
        contentHtml: cached.content_html === null ? null : sanitizeHtml(String(cached.content_html)),
        truncated: Number(cached.truncated ?? 0) === 1,
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

  // The whole post when there is a post to translate, the title and summary
  // when there is not. A feed that publishes teasers only — and there are a
  // lot of them — has nothing else to give, and the reader still gets a page
  // it can read.
  const body = String(input.contentHtml ?? '');
  const wholeArticle = textLength(body) >= MIN_ARTICLE_CHARS;

  let fresh;
  try {
    fresh = wholeArticle
      ? await translateArticle({
          title: input.title,
          summary: input.summary,
          contentHtml: body,
          targetLang: target,
          sourceLang: source,
        })
      : await translatePost({
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

  // Sanitized before it is stored as well as before it is rendered. The model
  // is not a trusted author — a post can ask it for a script tag — and a
  // sanitizer that only runs at render time is one forgotten call site away
  // from serving whatever came back.
  const translatedHtml = fresh.contentHtml ? sanitizeHtml(fresh.contentHtml) : null;

  await translations.saveTranslation(db, {
    itemId: input.itemId,
    lang: target,
    title: fresh.title,
    summary: fresh.summary,
    contentHtml: translatedHtml,
    truncated: Boolean(fresh.truncated),
    model: fresh.model,
    sourceLang: fresh.sourceLang ?? source,
  });

  return {
    translation: {
      title: fresh.title,
      summary: fresh.summary,
      contentHtml: translatedHtml,
      truncated: Boolean(fresh.truncated),
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
