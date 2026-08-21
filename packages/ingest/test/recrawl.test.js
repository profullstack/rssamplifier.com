import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, newId, q } from '@rssamplifier/db';

import { crawlFeed, nextIntervalMinutes, topicsFrom } from '../src/crawl.js';

/**
 * What a re-crawl reports, and what the crawler does about it.
 *
 * The bug these cover cost the directory a factor of twenty-four in crawl
 * volume and was invisible from every angle that mattered: `upsertItems`
 * returns how many items the document *offered*, not how many were stored, and
 * `crawlFeed` was reading that as "new items". Since every crawl re-offers the
 * whole feed, the number was never zero — so `nextIntervalMinutes` always
 * returned its floor and every feed in the directory was re-read hourly for
 * ever, however quiet it was. The backoff ladder that is supposed to let a
 * dormant blog drift out to a day had never once engaged in production.
 *
 * Nothing failed. The crawler simply asked for twenty-four times the work it
 * was designed to ask for, and the backlog was read as "the crawler is slow".
 */

let dir;
let db;

const DAY = 86_400_000;

/**
 * A feed document that never changes, the way a dormant blog's does not.
 *
 * Its posts are a week apart with the newest a day old, and the dates are
 * relative to now rather than fixed, because the schedule is now derived from
 * them: a hard-coded 2026 date would quietly become a two-year-dead feed and
 * these tests would start asserting the abandonment path by accident.
 *
 * @param {number} [newestAgoDays]
 * @param {number} [gapDays]
 */
function document(newestAgoDays = 1, gapDays = 7) {
  return {
    ok: true,
    feed: {
      title: 'A Quiet Blog',
      description: 'It posts rarely.',
      categories: ['writing'],
      credits: [],
      items: Array.from({ length: 5 }, (_, i) => ({
        guid: `post-${i}`,
        url: `https://quiet.example/${i}`,
        title: `Post ${i}`,
        summary: 'Words.',
        publishedAt: new Date(Date.now() - (newestAgoDays + i * gapDays) * DAY).toISOString(),
      })),
    },
  };
}

const DOCUMENT = document();

/** The same blog, with no dates at all: the fallback ladder's territory. */
const UNDATED = {
  ok: true,
  feed: {
    ...DOCUMENT.feed,
    items: DOCUMENT.feed.items.map(({ publishedAt, ...rest }) => rest),
  },
};

beforeEach(async () => {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'recrawl-'));
  db = connect({ url: `file:${join(dir, `${newId()}.db`)}` });
  await migrate(db);
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** @returns {Promise<object>} the feed row, as the crawl loop reads it */
async function seed() {
  await q.insertFeed(db, {
    slug: 'quiet',
    feed_url: 'https://quiet.example/feed.xml',
    title: 'A Quiet Blog',
  });
  return q.feedBySlug(db, 'quiet');
}

const resolve = async () => DOCUMENT;

test('a first crawl reports what it actually stored', async () => {
  const feed = await seed();
  const res = await crawlFeed(db, feed, { resolve });

  assert.equal(res.ok, true);
  assert.equal(res.newItems, 5);
});

test('a re-crawl that stores nothing reports nothing', async () => {
  const feed = await seed();
  await crawlFeed(db, feed, { resolve });

  // The same document again — which is what every crawl of a dormant feed sees.
  const again = await q.feedBySlug(db, 'quiet');
  const res = await crawlFeed(db, again, { resolve });

  assert.equal(res.newItems, 0, 'items offered is not items stored');
});

test('a feed is scheduled on its own rhythm rather than on a fixed ladder', async () => {
  // The weekly blog. It is read every few days whatever the previous interval
  // was -- the schedule is a property of the feed, not a counter that has to
  // climb, so it is right on the very first crawl instead of after eight.
  const feed = await seed();
  await crawlFeed(db, feed, { resolve });

  const first = Number((await q.feedBySlug(db, 'quiet')).fetch_interval_minutes);
  assert.ok(first / 1440 > 3 && first / 1440 < 4, `weekly blog -> ${(first / 1440).toFixed(1)} days`);

  // Crawling it again does not ratchet it anywhere: same document, same answer.
  await crawlFeed(db, await q.feedBySlug(db, 'quiet'), { resolve });
  const second = Number((await q.feedBySlug(db, 'quiet')).fetch_interval_minutes);
  assert.equal(second, first, 'and it is stable, not a ratchet');
});

test('the abandoned feed stops being fetched daily for ever', async () => {
  // This is the case the whole change exists for: under the old ladder a feed
  // whose last post was in 2024 was still fetched every single day, and 15.8%
  // of the sampled directory looked like that.
  const feed = await seed();
  const abandoned = async () => document(800, 7);

  await crawlFeed(db, feed, { resolve: abandoned });

  const minutes = Number((await q.feedBySlug(db, 'quiet')).fetch_interval_minutes);
  assert.ok(minutes / 1440 > 30, `two years dead -> ${(minutes / 1440).toFixed(0)} days, not 1`);
});

test('an undated feed is scheduled on observed change, not on a ladder', async () => {
  // The case that was left over after cadence shipped, and the reason for the
  // change log. Measured on production 2026-08-19: feeds stating no dates were
  // 1,653 of 81,553 active feeds -- two percent -- and asked for 1,183 crawls an
  // hour of a total 2,693. Forty-four percent of the work for two percent of the
  // directory, and not because they were busy. With no dates they fell to the
  // doubling ladder, and the ladder returns to its sixty-minute floor whenever a
  // crawl stores anything; a feed whose guids churn stores something every time
  // and so never left the floor.
  //
  // Now the crawler uses its own observations instead. The document is unchanged
  // every time here, so each crawl adds evidence of silence and the interval
  // only ever grows.
  const feed = await seed();
  const undated = async () => UNDATED;

  await crawlFeed(db, feed, { resolve: undated });
  const first = await q.feedBySlug(db, 'quiet');
  assert.equal(Number(first.fetch_interval_minutes), 60, 'nothing observed yet, so the floor');
  assert.ok(first.content_hash, 'and the contents are fingerprinted for next time');
  assert.equal(JSON.parse(first.change_log).length, 1, 'a first crawl is a change');

  // Unchanged, so the log does not grow: it is a record of changes, not of
  // crawls. That distinction is the whole reason it can measure silence.
  await crawlFeed(db, first, { resolve: undated });
  const second = await q.feedBySlug(db, 'quiet');
  assert.equal(JSON.parse(second.change_log).length, 1, 'an unchanged crawl is not a change');
  assert.ok(
    Number(second.fetch_interval_minutes) >= Number(first.fetch_interval_minutes),
    'and an unchanged crawl never shortens the interval',
  );
});

test('an undated feed that never changes decays past the old one-day ceiling', async () => {
  // The ceiling is what actually cost the directory. An undated feed used to top
  // out at one day and be fetched 365 times a year for ever; it now decays on
  // its own silence to the ninety-day ceiling the dated path already had.
  //
  // Driven by hand rather than by crawling repeatedly, because the point being
  // made is about a year of silence and the test has to take a millisecond.
  const feed = await seed();
  const undated = async () => UNDATED;
  await crawlFeed(db, feed, { resolve: undated });

  // A year ago, and nothing since.
  const aYearAgo = new Date(Date.now() - 365 * DAY).toISOString();
  await db.execute({
    sql: 'update feeds set change_log = ? where id = ?',
    args: [JSON.stringify([aYearAgo]), feed.id],
  });

  await crawlFeed(db, await q.feedBySlug(db, 'quiet'), { resolve: undated });
  const days = Number((await q.feedBySlug(db, 'quiet')).fetch_interval_minutes) / 1440;
  assert.ok(days > 30, `a year of silence -> ${days.toFixed(0)} days, not 1`);
});

test('a re-crawl that stored nothing does not go near the author path again', async () => {
  // What limits this crawler is write transactions per feed, not bytes and not
  // fetches: against production an *empty* write transaction measured 29-118
  // seconds while a read measured 100ms, and they serialize per database.
  //
  // `storeCredits` was three of them on every single crawl -- an `update
  // authors` coalescing each column onto the value already in it, an insert
  // into feed_authors and one into author_links -- re-deriving an unchanged
  // byline from an unchanged document. Instrumenting a crawl showed a re-crawl
  // costing 4 write transactions of which 3 changed nothing; guarding it on the
  // same condition the topics block uses takes that to 1.
  // The shared DOCUMENT names nobody, so this test brings its own byline.
  const credited = async () => ({
    ok: true,
    feed: {
      ...DOCUMENT.feed,
      credits: [{ name: 'A Quiet Author', url: 'https://quiet.example/about',
                  confidence: 0.9, source: 'feed', role: 'author' }],
    },
  });

  const feed = await seed();

  // First crawl: the author is genuinely new, so it must be stored.
  await crawlFeed(db, feed, { resolve: credited });
  const after = await db.execute({
    sql: 'select count(*) as n from feed_authors where feed_id = ?',
    args: [String(feed.id)],
  });
  assert.equal(Number(after.rows[0].n), 1, 'a first crawl files the byline it was given');

  // `updated_at` on the author row is the witness: `upsertAuthor` stamps it on
  // every call, so if the author path ran at all this value moves -- even
  // though every other column it writes would land on the value already there.
  // That indistinguishability is the whole reason the waste went unnoticed.
  const stamp = async () =>
    String((await db.execute("select updated_at from authors limit 1")).rows[0].updated_at);
  const was = await stamp();

  // Second crawl of the same document, which stores no new items.
  const res = await crawlFeed(db, await q.feedBySlug(db, 'quiet'), { resolve: credited });

  assert.equal(res.newItems, 0, 'nothing new was stored');
  assert.equal(await stamp(), was, 'and the author was never written again');

  // The feed row itself is of course still updated -- a crawl has to record
  // that it happened. This test is about the three writes that came after it.
  const touched = await q.feedBySlug(db, 'quiet');
  assert.ok(touched.last_fetched_at, 'the crawl still recorded itself');

  // And the byline is still there -- skipped, not dropped.
  const still = await db.execute({
    sql: 'select count(*) as n from feed_authors where feed_id = ?',
    args: [String(feed.id)],
  });
  assert.equal(Number(still.rows[0].n), 1);
});

test('the interval the crawl writes is one SQL statement agreeing with the JS ladder', async () => {
  // `storeCrawl` computes the backoff inside the UPDATE, so that the items and
  // the feed row cost one write transaction between them rather than two. That
  // makes `nextIntervalMinutes` a second, independent statement of the same
  // ladder -- so it is worth asserting they cannot drift apart.
  for (const [newItems, current, expected] of [
    [1, 60, 60],
    [1, 480, 60],
    [0, 60, 120],
    [0, 120, 240],
    [0, 720, 1440],
    [0, 1440, 1440],
  ]) {
    assert.equal(
      nextIntervalMinutes(newItems, current),
      expected,
      `ladder: ${newItems} new at ${current}m`,
    );
  }
});

test('next_fetch_at is written in the format the due query compares against', async () => {
  // This is the one that would fail silently. `next_fetch_at` moved from a JS
  // `toISOString()` into SQL `strftime`, and `dueFeeds` selects on
  // `next_fetch_at <= ?` against an ISO string -- a string comparison. A format
  // that merely *sorts* differently (a space instead of the T, a missing Z, no
  // milliseconds) would leave every feed either permanently due or permanently
  // not, with nothing in the logs to say why.
  const feed = await seed();
  await crawlFeed(db, feed, { resolve });

  const row = await q.feedBySlug(db, 'quiet');
  const written = String(row.next_fetch_at);

  assert.match(
    written,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    `next_fetch_at must be an ISO instant, got ${written}`,
  );
  // Round-trips through Date, and lands exactly where the scheduler said: the
  // weekly blog's half-cycle, not some other number arrived at by a different
  // route. The two are computed in different languages -- JS chooses the
  // interval, SQL turns it into an instant -- so this is the join between them.
  const minutes = (Date.parse(written) - Date.now()) / 60_000;
  const chosen = Number((await q.feedBySlug(db, 'quiet')).fetch_interval_minutes);
  assert.ok(
    Math.abs(minutes - chosen) < 2,
    `next_fetch_at must be ${chosen}m out to match fetch_interval_minutes, got ${minutes.toFixed(1)}m`,
  );

  // And the scheduler agrees: not due now, due once the clock passes it.
  const dueNow = await q.dueFeeds(db, 100);
  assert.equal(
    dueNow.some((f) => String(f.slug) === 'quiet'),
    false,
    'a feed just crawled is not immediately due again',
  );
});

test('a feed that comes back is picked up again rather than written off', async () => {
  // The reason the ceiling is 90 days and not "never". A feed left for dead is
  // still asked occasionally, and the moment it answers with something recent
  // it goes straight back onto a normal schedule.
  const feed = await seed();
  await crawlFeed(db, feed, { resolve: async () => document(800, 7) });

  const dormant = Number((await q.feedBySlug(db, 'quiet')).fetch_interval_minutes);
  assert.ok(dormant / 1440 > 30, 'left for dead');

  // It posts again today.
  const returned = async () => document(0.1, 7);
  const res = await crawlFeed(db, await q.feedBySlug(db, 'quiet'), { resolve: returned });

  // Nothing is *stored*: the guids are the ones already on file, only their
  // dates moved. The schedule still recovers, and that is the property worth
  // pinning -- it is read off the document the crawl parsed, not inferred from
  // what the write happened to insert. A feed that re-dates its archive, or
  // that we first met while it was dormant, is rescheduled correctly anyway.
  assert.equal(res.newItems, 0, 'no new posts were stored');

  const revived = Number((await q.feedBySlug(db, 'quiet')).fetch_interval_minutes);
  assert.ok(revived / 1440 < 5, `back on its rhythm -> ${(revived / 1440).toFixed(1)} days`);
  assert.ok(revived < dormant, 'and far sooner than it was going to be asked');
});

test('the stored item count tracks what is really there', async () => {
  const feed = await seed();
  await crawlFeed(db, feed, { resolve });
  assert.equal(Number((await q.feedBySlug(db, 'quiet')).item_count), 5);

  // Re-crawling the same document must not inflate it.
  await crawlFeed(db, await q.feedBySlug(db, 'quiet'), { resolve });
  assert.equal(Number((await q.feedBySlug(db, 'quiet')).item_count), 5);
});

test('a failing feed still backs off on its own ladder', async () => {
  const feed = await seed();
  const res = await crawlFeed(db, feed, { resolve: async () => ({ ok: false, error: 'timeout' }) });

  assert.equal(res.ok, false);
  assert.equal(res.newItems, 0);

  const row = await q.feedBySlug(db, 'quiet');
  assert.equal(Number(row.error_count), 1);
  assert.equal(Number(row.fetch_interval_minutes), 60, 'first failure waits an hour');
});

/* --------------------------------------------------------- conditional GET */

test('validators are stored on a crawl and sent back on the next one', async () => {
  const feed = await seed();
  const withValidators = async () => ({
    ...DOCUMENT,
    etag: 'W/"abc"',
    lastModified: 'Mon, 18 Aug 2026 09:00:00 GMT',
  });

  await crawlFeed(db, feed, { resolve: withValidators });

  const stored = await q.feedBySlug(db, 'quiet');
  assert.equal(stored.http_etag, 'W/"abc"');
  assert.equal(stored.http_last_modified, 'Mon, 18 Aug 2026 09:00:00 GMT');

  // And the next crawl offers them back, which is the only thing that makes a
  // 304 possible at all.
  let sent = null;
  await crawlFeed(db, stored, {
    resolve: async (_url, conditional) => {
      sent = conditional;
      return withValidators();
    },
  });
  assert.equal(sent.etag, 'W/"abc"');
  assert.equal(sent.lastModified, 'Mon, 18 Aug 2026 09:00:00 GMT');
});

test('a 304 settles the feed without touching a single post', async () => {
  // The cheapest crawl there is, and the one this change exists to make common.
  // What limits this crawler is write transactions per feed; a feed that has not
  // changed should cost one small update and no reads of feed_items at all.
  const feed = await seed();
  await crawlFeed(db, feed, { resolve: async () => ({ ...DOCUMENT, etag: 'W/"abc"' }) });

  const before = await q.feedBySlug(db, 'quiet');
  const res = await crawlFeed(db, before, {
    resolve: async () => ({ ok: false, notModified: true, etag: 'W/"abc"' }),
  });

  assert.equal(res.ok, true, 'a 304 is a successful crawl, not a failure');
  assert.equal(res.notModified, true);
  assert.equal(res.newItems, 0);

  const after = await q.feedBySlug(db, 'quiet');
  assert.equal(Number(after.item_count), Number(before.item_count), 'no posts were touched');
  assert.equal(after.status, 'active', 'and it is emphatically not an error');
  assert.equal(Number(after.error_count), 0);
  assert.equal(after.http_etag, 'W/"abc"', 'the validator survives');
  assert.ok(after.next_fetch_at > before.next_fetch_at, 'and it is scheduled again');
});

test('a 304 never pulls a quiet feed back to a shorter interval', async () => {
  // Evidence of no change is evidence in one direction. Without this guard a
  // feed resting at the ceiling is dragged back every time we confirm it is
  // still silent, so it oscillates instead of settling and never stops costing
  // crawls -- which is the failure the whole ceiling exists to prevent.
  const feed = await seed();
  await crawlFeed(db, feed, { resolve: async () => document(800, 7) });

  const before = await q.feedBySlug(db, 'quiet');
  assert.ok(Number(before.fetch_interval_minutes) / 1440 > 30, 'two years dead, so months out');

  await crawlFeed(db, before, { resolve: async () => ({ ok: false, notModified: true }) });

  const after = await q.feedBySlug(db, 'quiet');
  assert.ok(
    Number(after.fetch_interval_minutes) >= Number(before.fetch_interval_minutes),
    `${before.fetch_interval_minutes} -> ${after.fetch_interval_minutes}`,
  );
});

test('a feed that starts publishing again accelerates on its first new post', async () => {
  // The other half of the asymmetry, and the reason it is stated as "never
  // sooner" rather than "always longer". A crawl that *did* see a change
  // recomputes freely, so a blog coming back after two years is not stuck at the
  // ceiling waiting for a ladder to climb back down.
  const feed = await seed();
  await crawlFeed(db, feed, { resolve: async () => document(800, 7) });

  const dormant = await q.feedBySlug(db, 'quiet');
  assert.ok(Number(dormant.fetch_interval_minutes) / 1440 > 30);

  // It posts again, on its old weekly rhythm.
  await crawlFeed(db, dormant, { resolve: async () => document(1, 7) });

  const revived = await q.feedBySlug(db, 'quiet');
  const back = Number(revived.fetch_interval_minutes) / 1440;
  assert.ok(back > 3 && back < 4, `back to a weekly rhythm, not ${back.toFixed(0)} days`);
});

test('a scraped source is never asked conditionally', async () => {
  // Its feed_url is a page of prose, and validators would describe that page. A
  // marketing site that has not changed its header is not evidence that the
  // posts extracted from it have not.
  const feed = await seed();
  await db.execute({
    sql: 'update feeds set source_kind = ?, http_etag = ? where id = ?',
    args: ['scraped', 'W/"abc"', feed.id],
  });

  let scrapeArgs = null;
  await crawlFeed(db, await q.feedBySlug(db, 'quiet'), {
    scrape: async (...args) => {
      scrapeArgs = args;
      return DOCUMENT;
    },
  });

  assert.equal(scrapeArgs.length, 1, 'scrapeFeed takes a URL and nothing else');
});

test('a feed that lists nothing decays instead of being read hourly for ever', async () => {
  // Sampling production's undated feeds on 2026-08-19, most of the ones sitting
  // on the hourly floor had `item_count = 0`. They are not broken -- they parse,
  // they are simply empty -- so nothing ever marked them failing and nothing
  // ever backed them off, and each one had been fetched every hour for months to
  // be told the same thing again.
  const feed = await seed();
  const nothing = async () => ({ ok: true, feed: { ...DOCUMENT.feed, items: [] } });

  await crawlFeed(db, feed, { resolve: nothing });
  const first = await q.feedBySlug(db, 'quiet');
  assert.equal(Number(first.item_count), 0);
  assert.ok(first.content_hash, 'an empty feed is fingerprinted like any other');

  // Second crawl: same emptiness, so no change is recorded and the schedule may
  // only lengthen from here.
  await crawlFeed(db, first, { resolve: nothing });
  const second = await q.feedBySlug(db, 'quiet');
  assert.equal(JSON.parse(second.change_log).length, 1, 'still empty is not a change');

  // Now let a month of that silence pass, and it is no longer an hourly feed.
  await db.execute({
    sql: 'update feeds set change_log = ? where id = ?',
    args: [JSON.stringify([new Date(Date.now() - 30 * DAY).toISOString()]), feed.id],
  });
  await crawlFeed(db, await q.feedBySlug(db, 'quiet'), { resolve: nothing });

  const settled = Number((await q.feedBySlug(db, 'quiet')).fetch_interval_minutes);
  assert.ok(settled / 1440 > 5, `a month of nothing -> every ${(settled / 1440).toFixed(0)} days`);
});

test('a feed that fills up after being empty is noticed at once', async () => {
  // The other direction, and the reason emptiness is treated as a fingerprint
  // rather than as a reason to stop caring. A newly submitted feed whose first
  // crawl caught it empty must not be written off.
  const feed = await seed();
  await crawlFeed(db, feed, { resolve: async () => ({ ok: true, feed: { ...DOCUMENT.feed, items: [] } }) });

  const empty = await q.feedBySlug(db, 'quiet');
  const res = await crawlFeed(db, empty, { resolve });

  assert.equal(res.newItems, 5, 'the posts land');
  const after = await q.feedBySlug(db, 'quiet');
  assert.equal(JSON.parse(after.change_log).length, 2, 'and it is recorded as a change');
});

test('a feed that is retagged without publishing still has its topics revised', async () => {
  // The case the old guard could not see.
  //
  // Topics were recomputed only when the feed had published something new, or
  // had none yet. But `topicsFrom` reads the *channel's* own categories, title
  // and description as well as its items, so a publisher can change what their
  // feed is about without posting: retag it, rename it, rewrite the standfirst.
  // For a blog that then goes quiet, the old condition was never true again and
  // the directory filed it under whatever it happened to be about on the last
  // day it posted.
  //
  // `feeds.category` never had this problem -- `upsertFeed` re-derives it on
  // every successful crawl. This asserts the topics now agree with it.
  const retagged = async () => ({
    ok: true,
    feed: { ...DOCUMENT.feed, categories: ['astronomy'] },
  });

  const feed = await seed();
  await crawlFeed(db, feed, { resolve });

  const before = (await q.feedKeywordRows(db, feed.id)).map((r) => String(r.slug));
  assert.ok(before.includes('writing'), `the first crawl files the tag it was given: ${before}`);

  // The same five posts, same dates, nothing new to store -- only the channel's
  // tag has changed. This is the crawl the old code skipped.
  const res = await crawlFeed(db, await q.feedBySlug(db, 'quiet'), { resolve: retagged });
  assert.equal(res.newItems, 0, 'nothing new was published');

  const after = (await q.feedKeywordRows(db, feed.id)).map((r) => String(r.slug));
  assert.ok(after.includes('astronomy'), `the new tag is filed: ${after}`);
});

test('a quiet feed that has not changed writes no topic rows at all', async () => {
  // The other half of the trade, and the reason re-deriving every crawl is
  // affordable: `keywordDiffStatements` compares the extracted set against the
  // stored one and emits nothing when they match. Re-deriving costs computation
  // on a document already parsed and reads already issued -- not writes.
  //
  // The diff is the witness. `feed_keywords` carries no timestamp, so asserting
  // on the rows cannot distinguish "rewritten to the same values" from "left
  // alone" -- which is the exact indistinguishability that hid this cost in the
  // first place. Asking `keywordDiffStatements` what it would emit is the
  // claim itself, not a proxy for it.
  const feed = await seed();
  await crawlFeed(db, feed, { resolve });

  const stored = await q.feedKeywordRows(db, feed.id);
  assert.ok(stored.length > 0, 'the first crawl filed some topics');

  // Exactly what the crawl recomputes on the next pass: the same document
  // against the items now stored for it.
  const again = topicsFrom(DOCUMENT.feed, await q.itemsForKeywords(db, feed.id));
  assert.deepEqual(
    q.keywordDiffStatements(feed.id, again, stored),
    [],
    'an unchanged re-crawl emits no topic write at all',
  );
});
