import { nowIso } from './client.js';

/**
 * Cached machine translations, and the language list they are offered in.
 *
 * The translating itself lives in @rssamplifier/translate — this module only
 * knows how to look one up, put one back, and answer "which languages is this
 * directory actually full of".
 *
 * @typedef {import('@libsql/client').Client} Client
 */

/**
 * One post's translation into one language, or null.
 *
 * @param {Client} db
 * @param {string} itemId
 * @param {string} lang bare ISO-639-1 code
 * @returns {Promise<{ title: string, summary: string|null, model: string, source_lang: string|null }|null>}
 */
export async function translationFor(db, itemId, lang) {
  const { rows } = await db.execute({
    sql: `select title, summary, model, source_lang
          from item_translations where item_id = ? and lang = ? limit 1`,
    args: [itemId, lang],
  });
  return /** @type {any} */ (rows[0]) ?? null;
}

/**
 * Store a translation, replacing any earlier one for the same language.
 *
 * Replacing rather than ignoring the conflict means re-running a post through a
 * better model is a plain insert, with no delete step to forget.
 *
 * @param {Client} db
 * @param {{
 *   itemId: string,
 *   lang: string,
 *   title: string,
 *   summary?: string|null,
 *   model: string,
 *   sourceLang?: string|null,
 * }} row
 */
export async function saveTranslation(db, row) {
  await db.execute({
    sql: `insert into item_translations
            (item_id, lang, title, summary, model, source_lang, created_at)
          values (?, ?, ?, ?, ?, ?, ?)
          on conflict (item_id, lang) do update set
            title = excluded.title,
            summary = excluded.summary,
            model = excluded.model,
            source_lang = excluded.source_lang,
            created_at = excluded.created_at`,
    args: [
      row.itemId,
      row.lang,
      row.title,
      row.summary ?? null,
      row.model,
      row.sourceLang ?? null,
      nowIso(),
    ],
  });
}

/**
 * The raw text of a post, addressed by id.
 *
 * itemsForFeed() does not carry everything the translator wants, and the reader
 * page has already narrowed to one post by the time it asks.
 *
 * @param {Client} db
 * @param {string} itemId
 * @returns {Promise<{ id: string, title: string, summary: string|null }|null>}
 */
export async function itemText(db, itemId) {
  const { rows } = await db.execute({
    sql: 'select id, title, summary from feed_items where id = ? limit 1',
    args: [itemId],
  });
  return /** @type {any} */ (rows[0]) ?? null;
}

/**
 * How many feeds the directory holds in each language, commonest first.
 *
 * Callers get raw `language` values straight out of the feed metadata — 'de',
 * 'de-DE' and 'DE' are all distinct rows here. Folding them together is the
 * caller's job because only it knows which codes it can actually offer.
 *
 * @param {Client} db
 * @param {number} [limit] distinct raw values to consider
 * @returns {Promise<Array<{ language: string, feeds: number }>>}
 */
export async function languageCounts(db, limit = 100) {
  const { rows } = await db.execute({
    sql: `select language, count(*) as feeds
          from feeds
          where language is not null and trim(language) <> ''
          group by language
          order by feeds desc
          limit ?`,
    args: [limit],
  });

  return rows.map((r) => ({ language: String(r.language), feeds: Number(r.feeds) }));
}

/* ------------------------------------------------------------------ spend */

/**
 * The UTC calendar day a translation is billed against.
 *
 * UTC rather than the reader's zone so the global cap is one number over one
 * window, instead of a quota that resets 24 times as the day moves west.
 *
 * @param {Date} [at]
 * @returns {string} YYYY-MM-DD
 */
export function usageDay(at) {
  return (at ?? new Date()).toISOString().slice(0, 10);
}

/**
 * How many paid translations one reader has run up today.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} day
 * @returns {Promise<number>}
 */
export async function usageForUser(db, userId, day) {
  const { rows } = await db.execute({
    sql: 'select count from translation_usage where user_id = ? and day = ? limit 1',
    args: [userId, day],
  });
  return Number(rows[0]?.count ?? 0);
}

/**
 * How many paid translations everybody has run up today.
 *
 * @param {Client} db
 * @param {string} day
 * @returns {Promise<number>}
 */
export async function usageForDay(db, day) {
  const { rows } = await db.execute({
    sql: 'select coalesce(sum(count), 0) as total from translation_usage where day = ?',
    args: [day],
  });
  return Number(rows[0]?.total ?? 0);
}

/**
 * Charge one translation to a reader's day, and report the new total.
 *
 * Incremented in the statement rather than read-then-written, so two requests
 * landing together cannot both read 9 and both write 10. The check that gates
 * the call is still a separate read, so a burst can overshoot a limit by the
 * number of requests in flight — a handful of calls, not an open tap, and far
 * cheaper than serialising every translation behind a lock.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string} day
 * @returns {Promise<number>} the reader's new total for the day
 */
export async function recordUsage(db, userId, day) {
  await db.execute({
    sql: `insert into translation_usage (user_id, day, count)
          values (?, ?, 1)
          on conflict (user_id, day) do update set count = count + 1`,
    args: [userId, day],
  });

  return usageForUser(db, userId, day);
}

/* ------------------------------------------------------------ preferences */

/**
 * The reader's chosen reading language, or null for "no preference".
 *
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
export async function readingLanguage(db, userId) {
  const { rows } = await db.execute({
    sql: 'select reading_language from users where id = ? limit 1',
    args: [userId],
  });
  const value = rows[0]?.reading_language;
  return value ? String(value) : null;
}

/**
 * Remember the reader's chosen language, so the next post arrives in it.
 *
 * @param {Client} db
 * @param {string} userId
 * @param {string|null} lang null clears the preference
 */
export async function setReadingLanguage(db, userId, lang) {
  await db.execute({
    sql: 'update users set reading_language = ? where id = ?',
    args: [lang, userId],
  });
}
