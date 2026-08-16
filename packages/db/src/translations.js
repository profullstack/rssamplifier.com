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
