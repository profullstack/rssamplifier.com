/**
 * Removing a feed at its owner's request, and keeping it out.
 *
 * Two halves. `removeFeed` takes a publisher down: the feed row, its items,
 * extracts, links and author association go with it (foreign keys cascade),
 * an author record nothing else refers to goes too, and the request is
 * written to `feed_removals`. `isRemovedUrl` / `dropRemoved` are the other
 * half: the insert paths ask before adding a feed, so discovery, a bulk import
 * or a fresh submission cannot bring a removed publisher back.
 *
 * Matching is by host, not only by exact URL. The request was about the
 * publisher, and a publisher has as many feed URLs as their platform offers.
 */

import { newId, nowIso } from './client.js';

/** @typedef {import('@libsql/client').Client} Client */

/** Thrown by an insert path when the URL belongs to a removed publisher. */
export class FeedRemovedError extends Error {
  /**
   * @param {string} feedUrl
   * @param {string} host
   */
  constructor(feedUrl, host) {
    super(`${host} was removed from the directory at its owner's request`);
    this.name = 'FeedRemovedError';
    this.feedUrl = feedUrl;
    this.host = host;
  }
}

/**
 * The host a removal is keyed on: lower-case, no port, no leading "www.".
 *
 * @param {string} url
 * @returns {string|null} null when the URL does not parse
 */
export function removalHost(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * Is this URL, or anything on its host, removed?
 *
 * @param {Client} db
 * @param {string} feedUrl
 * @returns {Promise<boolean>}
 */
export async function isRemovedUrl(db, feedUrl) {
  const host = removalHost(feedUrl);
  const { rows } = await db.execute({
    sql: 'select 1 from feed_removals where feed_url = ? or host = ? limit 1',
    args: [String(feedUrl), host ?? ''],
  });
  return rows.length > 0;
}

/**
 * The subset of `feeds` whose URL is not removed, in one query.
 *
 * Bulk paths insert hundreds of rows at a time; asking per row would turn one
 * round trip into hundreds. Hosts are looked up as a set instead.
 *
 * @template {{ feed_url: string }} T
 * @param {Client} db
 * @param {T[]} feeds
 * @returns {Promise<T[]>}
 */
export async function dropRemoved(db, feeds) {
  if (feeds.length === 0) return feeds;
  const hosts = [...new Set(feeds.map((f) => removalHost(f.feed_url)).filter(Boolean))];
  const urls = feeds.map((f) => String(f.feed_url));
  const removed = new Set();

  // SQLite's parameter limit is comfortably above the 500-row chunks the bulk
  // paths use, but chunk anyway so a larger caller cannot trip it.
  const CHUNK = 400;
  for (let i = 0; i < Math.max(hosts.length, urls.length); i += CHUNK) {
    const h = hosts.slice(i, i + CHUNK);
    const u = urls.slice(i, i + CHUNK);
    const clauses = [];
    const args = [];
    if (h.length > 0) {
      clauses.push(`host in (${h.map(() => '?').join(', ')})`);
      args.push(...h);
    }
    if (u.length > 0) {
      clauses.push(`feed_url in (${u.map(() => '?').join(', ')})`);
      args.push(...u);
    }
    const { rows } = await db.execute({
      sql: `select feed_url, host from feed_removals where ${clauses.join(' or ')}`,
      args,
    });
    for (const row of rows) {
      removed.add(String(row.host));
      removed.add(String(row.feed_url));
    }
  }
  if (removed.size === 0) return feeds;
  return feeds.filter(
    (f) => !removed.has(String(f.feed_url)) && !removed.has(removalHost(f.feed_url) ?? '')
  );
}

/**
 * Take a publisher down and remember it.
 *
 * Every feed on the URL's host is deleted, not just the URL given, because a
 * removal request names a publisher. Authors left with no feed are deleted as
 * well: an author page with nothing under it is still the person's name on the
 * site. Returns what went, so the reply to the requester can say so.
 *
 * @param {Client} db
 * @param {{ feed_url: string, reason?: string|null, requested_by?: string|null }} request
 * @returns {Promise<{ host: string, feeds: { id: string, slug: string, feed_url: string, title: string|null, items: number }[], authors_removed: number, already_recorded: boolean }>}
 */
export async function removeFeed(db, request) {
  const feedUrl = String(request.feed_url).trim();
  const host = removalHost(feedUrl);
  if (!host) throw new Error(`not a URL: ${feedUrl}`);

  const { rows } = await db.execute({
    sql: `select id, slug, feed_url, title,
            (select count(*) from feed_items where feed_id = feeds.id) as items
          from feeds
          where lower(feed_url) like ? or lower(feed_url) like ? or lower(site_url) like ? or lower(site_url) like ?`,
    args: [`%://${host}/%`, `%://www.${host}/%`, `%://${host}/%`, `%://www.${host}/%`],
  });
  const feeds = rows
    .map((r) => ({
      id: String(r.id),
      slug: String(r.slug),
      feed_url: String(r.feed_url),
      title: r.title == null ? null : String(r.title),
      items: Number(r.items ?? 0),
    }))
    // `like` cannot anchor on the host boundary, so confirm each hit properly.
    .filter((f) => removalHost(f.feed_url) === host || f.feed_url === feedUrl);

  let authorsRemoved = 0;
  for (const feed of feeds) {
    const { rows: authorRows } = await db.execute({
      sql: `select author_id from feed_authors where feed_id = ?
              and author_id not in (select author_id from feed_authors where feed_id != ?)`,
      args: [feed.id, feed.id],
    });
    for (const row of authorRows) {
      await db.execute({ sql: 'delete from authors where id = ?', args: [String(row.author_id)] });
      authorsRemoved += 1;
    }
    // Items, extracts, links and the author association cascade from here.
    await db.execute({ sql: 'delete from feeds where id = ?', args: [feed.id] });
  }

  const { rows: existing } = await db.execute({
    sql: 'select 1 from feed_removals where feed_url = ? limit 1',
    args: [feedUrl],
  });
  const alreadyRecorded = existing.length > 0;
  if (!alreadyRecorded) {
    const first = feeds[0] ?? null;
    await db.execute({
      sql: `insert into feed_removals
              (id, feed_url, host, slug, title, reason, requested_by, items_removed, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId(),
        feedUrl,
        host,
        first?.slug ?? null,
        first?.title ?? null,
        request.reason ?? null,
        request.requested_by ?? null,
        feeds.reduce((sum, f) => sum + f.items, 0),
        nowIso(),
      ],
    });
  }

  return { host, feeds, authors_removed: authorsRemoved, already_recorded: alreadyRecorded };
}

/**
 * Every removal on record, newest first.
 *
 * @param {Client} db
 * @returns {Promise<{ feed_url: string, host: string, slug: string|null, reason: string|null, requested_by: string|null, items_removed: number, created_at: string }[]>}
 */
export async function listRemovals(db) {
  const { rows } = await db.execute(
    'select feed_url, host, slug, reason, requested_by, items_removed, created_at from feed_removals order by created_at desc'
  );
  return rows.map((r) => ({
    feed_url: String(r.feed_url),
    host: String(r.host),
    slug: r.slug == null ? null : String(r.slug),
    reason: r.reason == null ? null : String(r.reason),
    requested_by: r.requested_by == null ? null : String(r.requested_by),
    items_removed: Number(r.items_removed ?? 0),
    created_at: String(r.created_at),
  }));
}
