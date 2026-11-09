/**
 * Every subreddit in the directory, current within minutes, from one stream.
 *
 * Asking fifty thousand subreddits one at a time every hour is ~14 requests a
 * second, around the clock, to a volunteer-run mirror, and the per-host crawler
 * managed ~7 an hour. Reddit as a whole produces ~25 posts a second, and Arctic
 * Shift will page through all of them, oldest first, a hundred at a time — so
 * reading *every* new post on Reddit is ~15 requests a minute. Each post is
 * matched to the rows we hold (`r:sub:<subreddit>` and `r:user:<author>`) and
 * every matched row goes through `crawlFeed` with its posts already in hand,
 * so dedupe, keywords, FTS, alerts and scheduling are the crawl's own.
 *
 * The cursor lives in memory. A restart starts `lookbackSeconds` back, which is
 * safe because items dedupe by guid; the per-source crawl and the on-view
 * refresh cover anything older.
 */

import { q } from '@rssamplifier/db';
import { fetchRedditFirehosePage, redditPostToItem, redditResult } from '@rssamplifier/social';

import { crawlFeed } from './crawl.js';

const PAGE = 100;

/**
 * @param {{
 *   lookbackSeconds?: number,
 *   maxPages?: number,
 *   concurrency?: number,
 *   env?: Record<string, string|undefined>,
 *   fetchPage?: typeof fetchRedditFirehosePage,
 *   crawl?: typeof crawlFeed,
 *   now?: () => number,
 * }} [opts]
 */
export function createRedditFirehose(opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const fetchPage = opts.fetchPage ?? fetchRedditFirehosePage;
  const crawl = opts.crawl ?? crawlFeed;
  const maxPages = opts.maxPages ?? 80;
  const concurrency = opts.concurrency ?? 6;

  /** unix seconds; posts created after this are still to be read */
  let cursor = Math.floor(now() / 1000) - (opts.lookbackSeconds ?? 900);
  /** ids already handled near the cursor, since pages overlap by a second */
  let seen = new Set();

  /**
   * One pass: read pages until caught up or `maxPages`, then store.
   *
   * @param {import('@rssamplifier/db/src/pg.js').PgClient} db
   */
  return async function runRedditFirehose(db) {
    const posts = [];
    let pages = 0;
    for (; pages < maxPages; pages += 1) {
      const page = await fetchPage(cursor, { env: opts.env });
      for (const post of page) {
        const id = String(post?.id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        posts.push(post);
      }
      if (page.length === 0) break;

      const last = Number(page[page.length - 1]?.created_utc) || cursor;
      // Step back one second so a second split across two pages is read whole;
      // `seen` drops the overlap. A page that is all one second (100+ posts in
      // it) must move on, or the loop would ask the same page for ever.
      cursor = last - 1 > cursor ? last - 1 : last;
      if (page.length < PAGE) break;
    }
    if (seen.size > 20_000) seen = new Set([...seen].slice(-5_000));

    // Group by the refs a row can have.
    const byRef = new Map();
    const push = (ref, post) => {
      const list = byRef.get(ref);
      if (list) list.push(post);
      else byRef.set(ref, [post]);
    };
    for (const post of posts) {
      if (post?.subreddit) push(`r:sub:${String(post.subreddit).toLowerCase()}`, post);
      const author = String(post?.author ?? '');
      if (author && author !== '[deleted]') push(`r:user:${author.toLowerCase()}`, post);
    }

    const rows = byRef.size ? await q.feedsBySocialRefs(db, [...byRef.keys()]) : [];

    let crawled = 0;
    let failed = 0;
    let items = 0;
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const row = rows[next++];
        const ref = String(row.social_ref);
        const matched = (byRef.get(ref) ?? []).slice().sort((a, b) => b.created_utc - a.created_utc);
        const mapped = matched.map(redditPostToItem).filter(Boolean);
        if (mapped.length === 0) continue;
        const [, mode, name] = /^r:(sub|user):(.+)$/.exec(ref) ?? [];
        if (!mode) continue;
        try {
          const res = await crawl(db, row, {
            x: async () => redditResult(row, { mode: /** @type {'sub'|'user'} */ (mode), name }, matched, mapped),
          });
          if (res?.ok) {
            crawled += 1;
            items += Number(res.newItems ?? 0);
          } else failed += 1;
        } catch {
          failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, rows.length)) }, worker));

    return {
      pages,
      posts: posts.length,
      matched: rows.length,
      crawled,
      failed,
      items,
      lagSeconds: Math.max(0, Math.floor(now() / 1000) - cursor),
    };
  };
}
