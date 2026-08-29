import { newId, nowIso } from './client.js';

/**
 * The corpus: who may take it, what leaves, and the record of both.
 *
 * ## What is actually on offer, because it is not what it first looks like
 *
 * The obvious pitch — "4.7 million blog posts, full text" — is not true of this
 * database and saying it would be the fastest way to make a buyer's first pull
 * their last. Since `0031_item_body_on_demand.sql`, `feed_items.content_html` is
 * no longer written: it was 10 GB of a 14 GB database and the size was what made
 * write slots scarce. Bodies now live in `item_extracts`, which is populated
 * when a reader opens a post rather than on every crawl.
 *
 * So there are two datasets here with genuinely different characters, and the
 * manifest and the sales page both say so in as many words:
 *
 *   * `items` — every post record. Title, summary, author, canonical URL,
 *     publication date, and the feed it came from. Millions of rows, growing by
 *     hundreds of thousands a day. Metadata at scale, not prose.
 *   * `extracts` — the article itself, sanitized, for the subset anybody has
 *     read. Hundreds of thousands of rows averaging several thousand characters.
 *     Prose, at a fraction of the row count.
 *
 * A buyer who needs the second at the scale of the first is asking us to change
 * what the crawler stores, which is a conversation and not a query parameter.
 *
 * ## Why every stream here is a generator over a keyset cursor
 *
 * The same reason `eachFeedForExport` is. OFFSET makes SQLite walk and discard
 * the rows before it, so paging a 4.7M-row table costs O(n²) row visits; a
 * cursor compared against the last row seen lets each page start where the
 * previous one stopped. And a generator means nothing larger than one page is
 * ever resident, so a full dump does not have to fit in the web service's
 * memory before the first byte reaches the buyer.
 *
 * ## Why the cursors are on rowid and not on id
 *
 * `feed_items` and `item_extracts` are ordinary rowid tables whose text primary
 * key is a unique index rather than the row's address. SQLite stores the rowid
 * in every index entry, so `feed_items_created_idx (created_at)` is physically
 * `(created_at, rowid)` — which means a keyset on that exact pair seeks straight
 * into an index that already exists. A cursor on `(created_at, id)` would need a
 * new index over 4.7M rows, built at boot by the poller, against a database
 * whose write path is its binding constraint. The pair is unique because the
 * rowid is, so no two rows sharing a timestamp can straddle a page boundary
 * ambiguously.
 *
 * @typedef {import('@libsql/client').Client} Client
 */

/**
 * The streams a caller may ask for, and how each one is cut.
 *
 * Exported because three separate things need to agree on it — the manifest, the
 * route's validation and the audit log's `dataset` column — and a vocabulary
 * that lives in three places is a vocabulary that drifts.
 */
export const DATASETS = ['feeds', 'items', 'extracts', 'authors'];

/**
 * How wide a slice is, in hours.
 *
 * Four, matching the cadence the corpus is sold on. It is a constant rather than
 * a parameter because it is a contract: a buyer's incremental pipeline computes
 * the next boundary itself, and a window that changed width would silently leave
 * a gap in their corpus that nothing on either side would notice.
 */
export const WINDOW_HOURS = 4;

// ------------------------------------------------------------------ grants

/**
 * The licence this account is currently reading under, or null.
 *
 * Expiry and revocation are both evaluated here rather than by a job, so a
 * lapsed licence stops working at the instant it lapses and nothing has to be
 * running for that to be true.
 *
 * Newest first, so a renewal written beside an expiring row wins without anybody
 * having to tidy up the old one.
 *
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function activeGrant(db, userId) {
  const { rows } = await db.execute({
    sql: `select id, user_id, plan, per_window_downloads, full_dumps_per_day,
                 granted_at, expires_at, revoked_at, note
          from dataset_grants
          where user_id = ?
            and revoked_at is null
            and (expires_at is null or expires_at > ?)
          order by granted_at desc
          limit 1`,
    args: [userId, nowIso()],
  });
  return rows[0] ?? null;
}

/**
 * Every licence this account has held, for the account page to show.
 *
 * Includes the dead ones on purpose: "my access stopped working" is answered by
 * seeing the expiry date, and an account page that simply shows nothing sends
 * that question to a human instead.
 *
 * @param {Client} db
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
export async function grantsForUser(db, userId) {
  const { rows } = await db.execute({
    sql: `select id, plan, per_window_downloads, full_dumps_per_day,
                 granted_at, expires_at, revoked_at, note
          from dataset_grants where user_id = ? order by granted_at desc`,
    args: [userId],
  });
  return rows;
}

// ------------------------------------------------------------------ cadence

/**
 * How many times this licence has pulled one dataset for one window.
 *
 * Counts started pulls, not finished ones. A caller who opens the stream and
 * abandons it has still made us walk the index, and metering only completions
 * would make "start and hang up" a free way to run the query as often as you
 * like.
 *
 * @param {Client} db
 * @param {string} grantId
 * @param {string} dataset
 * @param {string} windowStart
 * @returns {Promise<number>}
 */
export async function windowDownloadCount(db, grantId, dataset, windowStart) {
  const { rows } = await db.execute({
    sql: `select count(*) as n from dataset_downloads
          where grant_id = ? and dataset = ? and window_start = ?`,
    args: [grantId, dataset, windowStart],
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * Full-history pulls this licence has started since a given moment.
 *
 * The caller passes the start of the UTC day rather than this computing it, for
 * the reason `crawlstats.js` derives its own clock-dependent numbers at serve
 * time: a boundary baked in here would be one more place for "now" to be wrong.
 *
 * @param {Client} db
 * @param {string} grantId
 * @param {string} sinceIso
 * @returns {Promise<number>}
 */
export async function fullDumpCount(db, grantId, sinceIso) {
  const { rows } = await db.execute({
    sql: `select count(*) as n from dataset_downloads
          where grant_id = ? and full_dump = 1 and created_at >= ?`,
    args: [grantId, sinceIso],
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * Open the audit record for a pull that is about to start streaming.
 *
 * Written before the first byte, not after the last, so a pull that dies partway
 * still counts against the window. That is the difference between a retry
 * allowance and an unmetered loop over a dropped connection.
 *
 * @param {Client} db
 * @param {{ grantId: string, userId: string, dataset: string, windowStart: string|null, fullDump?: boolean, apiKeyId?: string|null }} pull
 * @returns {Promise<string>} the download id, to close with {@link finishDownload}
 */
export async function startDownload(db, pull) {
  const id = newId();
  await db.execute({
    sql: `insert into dataset_downloads
            (id, grant_id, user_id, dataset, window_start, full_dump, api_key_id, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      pull.grantId,
      pull.userId,
      pull.dataset,
      pull.windowStart ?? null,
      pull.fullDump ? 1 : 0,
      pull.apiKeyId ?? null,
      nowIso(),
    ],
  });
  return id;
}

/**
 * Close it, with what actually left.
 *
 * A row whose `completed_at` is still null is a pull that broke, and telling the
 * two apart is most of what makes the audit log worth keeping.
 *
 * @param {Client} db
 * @param {string} id
 * @param {number} rowsSent
 * @returns {Promise<void>}
 */
export async function finishDownload(db, id, rowsSent) {
  await db.execute({
    sql: `update dataset_downloads set rows_sent = ?, completed_at = ? where id = ?`,
    args: [Math.max(0, Math.trunc(rowsSent)), nowIso(), id],
  });
}

/**
 * This licence's recent pulls, for the account page.
 *
 * @param {Client} db
 * @param {string} grantId
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function recentDownloads(db, grantId, limit = 20) {
  const { rows } = await db.execute({
    sql: `select dataset, window_start, full_dump, rows_sent, created_at, completed_at
          from dataset_downloads where grant_id = ?
          order by created_at desc limit ?`,
    args: [grantId, limit],
  });
  return rows;
}

// ------------------------------------------------------------------ enquiries

/**
 * Record a sales enquiry.
 *
 * @param {Client} db
 * @param {{ name?: string|null, email: string, org?: string|null, useCase: string, ipHash?: string|null, userAgent?: string|null }} enquiry
 * @returns {Promise<{ id: string }>}
 */
export async function insertEnquiry(db, enquiry) {
  const id = newId();
  await db.execute({
    sql: `insert into dataset_enquiries
            (id, name, email, org, use_case, ip_hash, user_agent, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      enquiry.name ?? null,
      enquiry.email,
      enquiry.org ?? null,
      enquiry.useCase,
      enquiry.ipHash ?? null,
      enquiry.userAgent ?? null,
      nowIso(),
    ],
  });
  return { id };
}

/**
 * How many enquiries one address has sent lately.
 *
 * The whole of the spam defence, alongside a honeypot field. The old contact
 * page refused to carry a form at all on the grounds that "a form on a site with
 * no accounts is one more thing to spam", and that reasoning is sound — this one
 * exists anyway because a sales page without a way to reply to it is not a sales
 * page, so the cost has to be paid rather than avoided.
 *
 * @param {Client} db
 * @param {string|null} ipHash
 * @param {string} sinceIso
 * @returns {Promise<number>}
 */
export async function enquiryCountFrom(db, ipHash, sinceIso) {
  if (!ipHash) return 0;
  const { rows } = await db.execute({
    sql: `select count(*) as n from dataset_enquiries where ip_hash = ? and created_at >= ?`,
    args: [ipHash, sinceIso],
  });
  return Number(rows[0]?.n ?? 0);
}

// ------------------------------------------------------------------ streams
//
// Each of the four below is a page function and a generator over it, in the
// shape `feedsForExportPage`/`eachFeedForExport` established. The page function
// is separate so it can be tested against a file-backed database without a
// generator in the way.

/** How many rows one page of any stream holds. */
const PAGE = 2000;

/**
 * One page of feeds, in ingest order.
 *
 * Cut on `created_at` rather than `updated_at`, and that is a product decision
 * rather than an index one. Every successful crawl touches `updated_at`, so an
 * incremental keyed on it would hand back most of the directory every window and
 * mean nothing; `created_at` answers "which feeds are new since I last looked",
 * which is the question a buyer maintaining a mirror is actually asking. It also
 * rides `feeds_sitemap_idx (created_at, id)`, which already exists.
 *
 * @param {Client} db
 * @param {{ since?: string|null, until?: string|null, afterCreated?: string|null, afterId?: string|null, limit?: number }} [cursor]
 * @returns {Promise<object[]>}
 */
export async function datasetFeedPage(
  db,
  { since = null, until = null, afterCreated = null, afterId = null, limit = PAGE } = {},
) {
  const resuming = afterCreated !== null && afterId !== null;

  const { rows } = await db.execute({
    sql: `select id, slug, feed_url, site_url, title, description, language, image_url,
                 author, categories, category, status, item_count, created_at, updated_at,
                 last_published_at
          from feeds
          where status <> 'dead'
            and dataset_opt_out = 0
            ${since ? 'and created_at >= ?' : ''}
            ${until ? 'and created_at < ?' : ''}
            ${resuming ? 'and (created_at > ? or (created_at = ? and id > ?))' : ''}
          order by created_at asc, id asc
          limit ?`,
    args: [
      ...(since ? [since] : []),
      ...(until ? [until] : []),
      ...(resuming ? [afterCreated, afterCreated, afterId] : []),
      limit,
    ],
  });
  return rows;
}

/**
 * Every feed in the slice, a page at a time.
 *
 * @param {Client} db
 * @param {{ since?: string|null, until?: string|null, pageSize?: number }} [slice]
 * @returns {AsyncGenerator<object>}
 */
export async function* eachDatasetFeed(db, { since = null, until = null, pageSize = PAGE } = {}) {
  let afterCreated = null;
  let afterId = null;

  for (;;) {
    const rows = await datasetFeedPage(db, {
      since,
      until,
      afterCreated,
      afterId,
      limit: pageSize,
    });
    if (rows.length === 0) return;
    for (const row of rows) yield row;

    const last = rows[rows.length - 1];
    afterCreated = String(last.created_at ?? '');
    afterId = String(last.id ?? '');
    if (rows.length < pageSize) return;
  }
}

/**
 * One page of posts, joined to the feed that carries them.
 *
 * The join is not decoration. It is how `dataset_opt_out` reaches a table that
 * does not carry the flag, and it is also what puts the feed's slug on the row —
 * without which a post record refers to a feed by an opaque id the buyer has no
 * way to resolve unless they took the `feeds` stream on the same day.
 *
 * `content_html` is selected even though the crawler stopped writing it: the
 * rows that predate `0031_item_body_on_demand.sql` still carry a body, and
 * silently dropping the one part of this table that is prose would be throwing
 * away the most valuable thing in it for tidiness.
 *
 * @param {Client} db
 * @param {{ since?: string|null, until?: string|null, afterCreated?: string|null, afterRowid?: number|null, limit?: number }} [cursor]
 * @returns {Promise<object[]>}
 */
export async function datasetItemPage(
  db,
  { since = null, until = null, afterCreated = null, afterRowid = null, limit = PAGE } = {},
) {
  const resuming = afterCreated !== null && afterRowid !== null;

  const { rows } = await db.execute({
    sql: `select i.rowid as cursor_rowid, i.id, i.feed_id, f.slug as feed_slug,
                 f.feed_url, f.site_url as feed_site_url, f.language, f.category,
                 i.guid, i.url, i.title, i.summary, i.content_html, i.content_chars,
                 i.author, i.image_url, i.published_at, i.created_at
          from feed_items i
          join feeds f on f.id = i.feed_id
          where f.dataset_opt_out = 0
            ${since ? 'and i.created_at >= ?' : ''}
            ${until ? 'and i.created_at < ?' : ''}
            ${resuming ? 'and (i.created_at > ? or (i.created_at = ? and i.rowid > ?))' : ''}
          order by i.created_at asc, i.rowid asc
          limit ?`,
    args: [
      ...(since ? [since] : []),
      ...(until ? [until] : []),
      ...(resuming ? [afterCreated, afterCreated, afterRowid] : []),
      limit,
    ],
  });
  return rows;
}

/**
 * Every post in the slice, a page at a time.
 *
 * @param {Client} db
 * @param {{ since?: string|null, until?: string|null, pageSize?: number }} [slice]
 * @returns {AsyncGenerator<object>}
 */
export async function* eachDatasetItem(db, { since = null, until = null, pageSize = PAGE } = {}) {
  let afterCreated = null;
  let afterRowid = null;

  for (;;) {
    const rows = await datasetItemPage(db, {
      since,
      until,
      afterCreated,
      afterRowid,
      limit: pageSize,
    });
    if (rows.length === 0) return;
    for (const row of rows) yield row;

    const last = rows[rows.length - 1];
    afterCreated = String(last.created_at ?? '');
    afterRowid = Number(last.cursor_rowid);
    if (rows.length < pageSize) return;
  }
}

/**
 * One page of extracted articles — the prose.
 *
 * Only `status = 'ok'`, and the constant is not a filter bolted on top: it is the
 * leading column of `item_extracts_fetched_idx (status, fetched_at)`, so pinning
 * it is what turns the timestamp range into an index seek. The other statuses
 * are a paywall, a JavaScript-only page or a refusal, and none of them is text.
 *
 * Cut on `fetched_at`, which is when we read the article rather than when it was
 * published. That is the correct clock for an incremental: a post from 2019 that
 * somebody opened this morning is new to this corpus today, and a buyer keyed on
 * publication date would never receive it.
 *
 * @param {Client} db
 * @param {{ since?: string|null, until?: string|null, afterFetched?: string|null, afterRowid?: number|null, limit?: number }} [cursor]
 * @returns {Promise<object[]>}
 */
export async function datasetExtractPage(
  db,
  { since = null, until = null, afterFetched = null, afterRowid = null, limit = PAGE } = {},
) {
  const resuming = afterFetched !== null && afterRowid !== null;

  const { rows } = await db.execute({
    sql: `select e.rowid as cursor_rowid, e.item_id, e.url, e.title, e.byline, e.excerpt,
                 e.site_name, e.content_html, e.text_length, e.fetched_at,
                 i.feed_id, f.slug as feed_slug, i.published_at
          from item_extracts e
          join feed_items i on i.id = e.item_id
          join feeds f on f.id = i.feed_id
          where e.status = 'ok'
            and f.dataset_opt_out = 0
            ${since ? 'and e.fetched_at >= ?' : ''}
            ${until ? 'and e.fetched_at < ?' : ''}
            ${resuming ? 'and (e.fetched_at > ? or (e.fetched_at = ? and e.rowid > ?))' : ''}
          order by e.fetched_at asc, e.rowid asc
          limit ?`,
    args: [
      ...(since ? [since] : []),
      ...(until ? [until] : []),
      ...(resuming ? [afterFetched, afterFetched, afterRowid] : []),
      limit,
    ],
  });
  return rows;
}

/**
 * Every extracted article in the slice, a page at a time.
 *
 * @param {Client} db
 * @param {{ since?: string|null, until?: string|null, pageSize?: number }} [slice]
 * @returns {AsyncGenerator<object>}
 */
export async function* eachDatasetExtract(db, { since = null, until = null, pageSize = PAGE } = {}) {
  let afterFetched = null;
  let afterRowid = null;

  for (;;) {
    const rows = await datasetExtractPage(db, {
      since,
      until,
      afterFetched,
      afterRowid,
      limit: pageSize,
    });
    if (rows.length === 0) return;
    for (const row of rows) yield row;

    const last = rows[rows.length - 1];
    afterFetched = String(last.fetched_at ?? '');
    afterRowid = Number(last.cursor_rowid);
    if (rows.length < pageSize) return;
  }
}

/**
 * One page of authors, with their links folded in.
 *
 * Walked by primary key rather than by time, because `authors` carries no index
 * on either of its timestamps and is small enough — a couple of hundred thousand
 * rows — that a full walk on the primary key is cheaper than the index that
 * would let it be sliced. `since` therefore filters rather than seeks, and is
 * honest about it: it is a scan of a small table, not a range read of a large
 * one.
 *
 * Links are aggregated in SQL rather than fetched per author. One row per author
 * with a JSON array beside it is one round trip; the alternative is a query per
 * author, which at this row count is the difference between a dump and an
 * afternoon.
 *
 * `verified` travels with each link on purpose. It is 1 only when the
 * destination links back — the rel="me" handshake — which is the difference
 * between "this account is theirs" and "this account was mentioned on their
 * page". A consumer building an identity graph needs to be able to tell those
 * apart, and collapsing them here would make every weak link look like a strong
 * one for ever.
 *
 * `authors.email` is deliberately absent, and this is the one exclusion in the
 * whole corpus that is not the publisher's own choice. The column holds only
 * addresses an author published as their own contact, and the schema that
 * created it says why that is dangerous: "anything stored here is something
 * somebody will email". Selling a quarter of a million contactable addresses to
 * be trained on is a different product from selling what people wrote, and not
 * one this directory is offering.
 *
 * @param {Client} db
 * @param {{ since?: string|null, until?: string|null, afterId?: string|null, limit?: number }} [cursor]
 * @returns {Promise<object[]>}
 */
export async function datasetAuthorPage(
  db,
  { since = null, until = null, afterId = null, limit = PAGE } = {},
) {
  const { rows } = await db.execute({
    sql: `select a.id, a.slug, a.name, a.bio, a.avatar_url, a.site_url, a.confidence,
                 a.created_at, a.updated_at,
                 (select json_group_array(json_object(
                            'network', l.network,
                            'url', l.url,
                            'handle', l.handle,
                            'source', l.source,
                            'verified', l.verified))
                    from author_links l where l.author_id = a.id) as links
          from authors a
          where 1 = 1
            ${since ? 'and a.created_at >= ?' : ''}
            ${until ? 'and a.created_at < ?' : ''}
            ${afterId ? 'and a.id > ?' : ''}
          order by a.id asc
          limit ?`,
    args: [...(since ? [since] : []), ...(until ? [until] : []), ...(afterId ? [afterId] : []), limit],
  });
  return rows;
}

/**
 * Every author in the slice, a page at a time.
 *
 * @param {Client} db
 * @param {{ since?: string|null, until?: string|null, pageSize?: number }} [slice]
 * @returns {AsyncGenerator<object>}
 */
export async function* eachDatasetAuthor(db, { since = null, until = null, pageSize = PAGE } = {}) {
  let afterId = null;

  for (;;) {
    const rows = await datasetAuthorPage(db, { since, until, afterId, limit: pageSize });
    if (rows.length === 0) return;
    for (const row of rows) yield row;

    afterId = String(rows[rows.length - 1].id ?? '');
    if (rows.length < pageSize) return;
  }
}

/**
 * The stream for a dataset name, or null if the name is not one.
 *
 * A lookup rather than a switch in the route, so `DATASETS` and the thing it
 * names cannot fall out of step: adding a name to that array without writing a
 * stream for it fails here, loudly, rather than serving an empty file.
 *
 * @param {string} name
 * @returns {((db: Client, slice: object) => AsyncGenerator<object>)|null}
 */
export function streamFor(name) {
  switch (name) {
    case 'feeds':
      return eachDatasetFeed;
    case 'items':
      return eachDatasetItem;
    case 'extracts':
      return eachDatasetExtract;
    case 'authors':
      return eachDatasetAuthor;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ opt-out

/**
 * Take a publisher out of the corpus, or put them back.
 *
 * Keyed on the feed's public slug, because that is what a publisher writing to
 * hello@ will have quoted at us — they know their page on this site, not its id.
 *
 * @param {Client} db
 * @param {string} slug
 * @param {boolean} optOut
 * @returns {Promise<boolean>} whether a feed changed
 */
export async function setDatasetOptOut(db, slug, optOut) {
  const res = await db.execute({
    sql: `update feeds set dataset_opt_out = ? where slug = ? and dataset_opt_out <> ?`,
    args: [optOut ? 1 : 0, slug, optOut ? 1 : 0],
  });
  return Number(res.rowsAffected ?? 0) > 0;
}

/**
 * How many publishers have opted out.
 *
 * Rides the partial index, so it costs a few pages rather than a scan. Shown on
 * /sales: a buyer is entitled to know the corpus has holes in it and roughly how
 * many, and a number that is currently very small is not a reason to hide it.
 *
 * @param {Client} db
 * @returns {Promise<number>}
 */
export async function optedOutCount(db) {
  const { rows } = await db.execute(
    `select count(*) as n from feeds where dataset_opt_out = 1`,
  );
  return Number(rows[0]?.n ?? 0);
}

// ------------------------------------------------------------------ figures

/**
 * How many articles the corpus holds in full text, and how long they run.
 *
 * Two numbers with deliberately different standing, and the sales page labels
 * them differently for that reason.
 *
 * `articles` is exact: `status = 'ok'` is the leading column of
 * `item_extracts_fetched_idx`, so counting it is a scan of one index rather than
 * of the table.
 *
 * `sampledAvgChars` is a sample and is described as one wherever it is shown.
 * The exact figure would be `sum(text_length)` over every row, and `text_length`
 * is not in any index — so it is a quarter of a million row lookups, which was
 * measured against production and did not return. An average over a bounded
 * sample answers the question a buyer is actually asking ("is this prose or is
 * it snippets?") for a cost the site can pay, and calling it a sample costs
 * nothing but a word.
 *
 * ## Why the sample is 2,000 and not 20,000
 *
 * It shipped at 20,000 and that number silently emptied two rows off the sales
 * page. Every row in the sample is a row lookup for a column no index covers, so
 * the cost is linear in the sample and nothing else. Measured against production
 * on 2026-08-29:
 *
 *     count(*) where status='ok'      1,946ms   274,885
 *     avg over 20,000                22,662ms     7,810
 *     avg over 2,000                    584ms     7,929
 *
 * The 20,000 blew through `corpusFigures`' timeout, so the whole read failed —
 * and a read-through cache stores nothing on failure, which is the exact trap
 * `cache.js` was written to describe: it does not fail once and recover, it
 * fails for ever, and the page renders its graceful fallback (no article count,
 * no author count) permanently.
 *
 * Ten times the sample bought a difference of 1.5% in a figure already labelled
 * "sampled", against 39 times the cost and a page that could not show it at all.
 * If a defensible exact total is ever wanted, the answer is a `sum(text_length)`
 * warmed by the poller on its patient connection, not a bigger sample here.
 *
 * @param {Client} db
 * @returns {Promise<{ articles: number, sampledAvgChars: number, sampleSize: number }>}
 */
export async function articleFigures(db) {
  const sampleSize = 2_000;

  const [count, sample] = await Promise.all([
    db.execute(`select count(*) as n from item_extracts where status = 'ok'`),
    db.execute({
      sql: `select avg(text_length) as n
            from (select text_length from item_extracts where status = 'ok' limit ?)`,
      args: [sampleSize],
    }),
  ]);

  return {
    articles: Number(count.rows[0]?.n ?? 0),
    sampledAvgChars: Math.round(Number(sample.rows[0]?.n ?? 0)),
    sampleSize,
  };
}
