import { nowIso } from './client.js';

/**
 * Articles read off pages the reader could not frame.
 *
 * The reader extracts on demand, in the request that needs it, so this table
 * is what stops the second reader of a post paying for it again — and, more to
 * the point, stops a popular post being fetched from the publisher once per
 * view.
 *
 * @typedef {import('@libsql/client').Client} Client
 *
 * @typedef {{
 *   itemId: string,
 *   url: string,
 *   title: string|null,
 *   byline: string|null,
 *   excerpt: string|null,
 *   siteName: string|null,
 *   contentHtml: string|null,
 *   length: number,
 *   status: 'ok'|'empty'|'blocked'|'error',
 *   reason: string|null,
 *   fetchedAt: string,
 * }} Extract
 */

/**
 * How long a failure stands before it is worth trying again.
 *
 * Failures are mostly transient in aggregate and permanent individually: a
 * paywall will still be a paywall tomorrow, but an origin that was down, a
 * timeout under load, or a page that had not finished publishing all clear up.
 * A day is long enough that a hard no costs one request per post per day, and
 * short enough that a soft no fixes itself before anyone reports it.
 */
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * A successful extraction is kept, and not refreshed.
 *
 * Articles are not edited often, and when they are, the version somebody read
 * here is not wrong — it is what the page said. Re-fetching on a timer would
 * spend requests on publishers to change text nobody asked to have changed.
 */

/**
 * The stored extraction for a post, if there is one.
 *
 * @param {Client} db
 * @param {string} itemId
 * @returns {Promise<Extract|null>}
 */
export async function forItem(db, itemId) {
  const { rows } = await db.execute({
    sql: `select item_id, url, title, byline, excerpt, site_name, content_html,
                 text_length, status, reason, fetched_at
          from item_extracts
          where item_id = ?
          limit 1`,
    args: [itemId],
  });

  const row = rows[0];
  if (!row) return null;

  return {
    itemId: String(row.item_id),
    url: String(row.url),
    title: str(row.title),
    byline: str(row.byline),
    excerpt: str(row.excerpt),
    siteName: str(row.site_name),
    contentHtml: str(row.content_html),
    length: Number(row.text_length ?? 0),
    status: /** @type {Extract['status']} */ (String(row.status)),
    reason: str(row.reason),
    fetchedAt: String(row.fetched_at),
  };
}

/**
 * Should the reader go and fetch this post's page?
 *
 * Nothing stored means yes. A stored success means no, ever. A stored failure
 * means not until it has gone stale — which is the case that matters, because
 * without it every view of a paywalled post is another request to the
 * publisher.
 *
 * @param {Extract|null} stored
 * @param {number} [now] epoch ms, injectable so the decision is testable
 * @returns {boolean}
 */
export function shouldFetch(stored, now = Date.now()) {
  if (!stored) return true;
  if (stored.status === 'ok') return false;

  const age = now - Date.parse(stored.fetchedAt);
  // An unparseable timestamp is a row we cannot reason about; treat it as due
  // rather than as permanently fresh.
  if (!Number.isFinite(age)) return true;
  return age >= RETRY_AFTER_MS;
}

/**
 * Record what came of reading a page, success or not.
 *
 * Failures are stored precisely so they are not retried on the next view; a
 * table that only remembers successes would leave every hopeless post being
 * fetched once per reader.
 *
 * @param {Client} db
 * @param {{
 *   itemId: string,
 *   url: string,
 *   status: 'ok'|'empty'|'blocked'|'error',
 *   reason?: string|null,
 *   article?: {
 *     title: string|null, byline: string|null, excerpt: string|null,
 *     siteName: string|null, html: string, length: number,
 *   }|null,
 * }} result
 * @returns {Promise<void>}
 */
export async function save(db, result) {
  const article = result.article ?? null;

  await db.execute({
    sql: `insert into item_extracts
            (item_id, url, title, byline, excerpt, site_name, content_html,
             text_length, status, reason, fetched_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (item_id) do update set
            url          = excluded.url,
            title        = excluded.title,
            byline       = excluded.byline,
            excerpt      = excluded.excerpt,
            site_name    = excluded.site_name,
            content_html = excluded.content_html,
            text_length  = excluded.text_length,
            status       = excluded.status,
            reason       = excluded.reason,
            fetched_at   = excluded.fetched_at`,
    args: [
      result.itemId,
      result.url,
      article?.title ?? null,
      article?.byline ?? null,
      article?.excerpt ?? null,
      article?.siteName ?? null,
      article?.html ?? null,
      article?.length ?? 0,
      result.status,
      result.reason ?? null,
      nowIso(),
    ],
  });
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function str(value) {
  return value === null || value === undefined ? null : String(value);
}
