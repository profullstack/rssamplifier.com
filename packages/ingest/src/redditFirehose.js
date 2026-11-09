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
 *   gapMs?: number,
 *   fetchBudgetMs?: number,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   maxLagSeconds?: number,
 *   resumeLagSeconds?: number,
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
  const maxPages = opts.maxPages ?? 30;
  // Reading stops at this deadline so the pass (reads plus writes) fits its
  // 60 s slot. A pass that overran the slot waited for the *next* one (the
  // daemon runs on a fixed grid), which halved throughput to ~6 pages a minute
  // against Reddit's ~9 (2026-11-09).
  const fetchBudgetMs = opts.fetchBudgetMs ?? 40_000;
  const concurrency = opts.concurrency ?? 6;
  // Arctic Shift answers 422 "Timeout. Maybe slow down a bit" after ~5 pages
  // back to back (measured 2026-11-09), and a page is ~6 s of Reddit, so pages
  // are spaced rather than fired: ~11 a minute is just over Reddit's own pace.
  const gapMs = opts.gapMs ?? 3_500;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // Never more than this far behind: past it, skip forward so every feed stays
  // inside the hour, and say how much was skipped.
  const maxLagSeconds = opts.maxLagSeconds ?? 50 * 60;
  const resumeLagSeconds = opts.resumeLagSeconds ?? 5 * 60;

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
    let skipped = 0;
    let limited = null;

    const nowSeconds = Math.floor(now() / 1000);
    if (nowSeconds - cursor > maxLagSeconds) {
      skipped = nowSeconds - resumeLagSeconds - cursor;
      cursor = nowSeconds - resumeLagSeconds;
    }

    const started = now();
    for (; pages < maxPages; pages += 1) {
      if (pages > 0 && now() - started + gapMs >= fetchBudgetMs) break;
      if (pages > 0 && gapMs > 0) await sleep(gapMs);
      let page;
      try {
        page = await fetchPage(cursor, { env: opts.env });
      } catch (error) {
        // The mirror asking us to slow down, or a bad minute: keep what this
        // pass already read and carry on from the cursor next pass.
        limited = String(error?.message ?? error);
        break;
      }
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
      skipped,
      limited,
    };
  };
}
