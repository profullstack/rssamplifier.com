import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { connectTest } from '../src/testdb.js';
import * as q from '../src/queries.js';

/**
 * Which feeds a category page leads with.
 *
 * A directory listed by arrival order is a directory that looks abandoned: the
 * top of /podcasts was whichever show the importer reached last, so a page
 * fronting 318,000 live feeds opened on ones that had published nothing for six
 * weeks. `order: 'published'` is the fix, and the part worth testing is not the
 * sort — it is that the feeds with no publish date yet are still in the list.
 * They are the ones somebody has just submitted, and dropping them to buy a
 * clean index scan would hide exactly the feeds whose submitters are watching
 * for them.
 */

let db;

before(async () => {
  db = await connectTest();
});

after(async () => {
  db.close();
});

/**
 * A feed with a chosen publish date and arrival time.
 *
 * `last_published_at` is written by the crawler rather than by insertFeed, and
 * `created_at` is written by the clock, so both are set by hand here: the whole
 * question is how rows with different combinations of the two sort against each
 * other.
 *
 * @param {{ slug: string, kind?: string, published?: string|null, created: string }} spec
 * @returns {Promise<object>}
 */
async function feed({ slug, kind = 'podcast', published = null, created }) {
  const row = await q.insertFeed(db, {
    slug,
    feed_url: `https://${slug}.example/feed.xml`,
    title: `${slug} show`,
    kind,
  });

  await db.execute({
    sql: 'update feeds set last_published_at = ?, created_at = ? where id = ?',
    args: [published, created, row.id],
  });

  return row;
}

/**
 * @param {number} days from now, negative for the past
 * @returns {string}
 */
function iso(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/**
 * @param {object[]} rows
 * @returns {string[]}
 */
function slugs(rows) {
  return rows.map((r) => String(r.slug));
}

test('the list leads with whoever published most recently', async () => {
  // Arrival order is deliberately the reverse of publish order: this is the
  // shape the live directory was in, and under the old ordering `stale` was the
  // row at the top of the page.
  await feed({ slug: 'fresh', published: iso(-1), created: iso(-90) });
  await feed({ slug: 'middling', published: iso(-20), created: iso(-60) });
  await feed({ slug: 'stale', published: iso(-45), created: iso(-2) });

  const rows = await q.listFeeds(db, { kind: 'podcast', order: 'published', limit: 10 });

  assert.deepEqual(slugs(rows), ['fresh', 'middling', 'stale']);
});

test('arrival order is still there for whoever wants it', async () => {
  // /submit sends people back to the directory to watch their feed turn up, so
  // the old ordering has to remain reachable rather than be replaced.
  const rows = await q.listFeeds(db, { kind: 'podcast', limit: 10 });

  assert.deepEqual(slugs(rows), ['stale', 'middling', 'fresh']);
});

test('a feed we have never read follows the ones we have', async () => {
  // Newest arrival of the lot, and no publish date at all: it is in the queue
  // for a first crawl. It cannot claim to be recent, and it must not vanish.
  await feed({ slug: 'unread', published: null, created: iso(0) });

  const rows = await q.listFeeds(db, { kind: 'podcast', order: 'published', limit: 10 });

  assert.deepEqual(slugs(rows), ['fresh', 'middling', 'stale', 'unread']);
});

test('paging across the boundary shows every feed exactly once', async () => {
  // The boundary between "has a publish date" and "does not" falls inside a
  // page here, which is the case the two queries exist to get right: an offset
  // applied to the wrong one of them either repeats a feed or skips it.
  await feed({ slug: 'unread-older', published: null, created: iso(-5) });

  const expected = ['fresh', 'middling', 'stale', 'unread', 'unread-older'];
  const seen = [];

  for (let page = 0; page < 5; page += 1) {
    const rows = await q.listFeeds(db, {
      kind: 'podcast',
      order: 'published',
      limit: 2,
      offset: page * 2,
    });
    seen.push(...slugs(rows));
    if (rows.length < 2) break;
  }

  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, seen.length, 'a feed appeared on two pages');
});

test('past the end is empty rather than wrapped around', async () => {
  const rows = await q.listFeeds(db, {
    kind: 'podcast',
    order: 'published',
    limit: 60,
    offset: 600,
  });

  assert.deepEqual(rows, []);
});

test('the category filter holds for both halves of the list', async () => {
  // A blog that published this morning outranks every podcast on date, and a
  // blog that has never been read outranks every unread podcast on arrival.
  // Neither belongs on /podcasts.
  await feed({ slug: 'loud-blog', kind: 'blog', published: iso(0), created: iso(-1) });
  await feed({ slug: 'new-blog', kind: 'blog', published: null, created: iso(0) });

  const rows = await q.listFeeds(db, { kind: 'podcast', order: 'published', limit: 60 });

  assert.deepEqual(slugs(rows), ['fresh', 'middling', 'stale', 'unread', 'unread-older']);
});

test('the whole directory is orderable too, not just one category', async () => {
  // No kind: the same ordering without the category predicate, which is the
  // path /api/feeds takes when it is asked for everything.
  const rows = await q.listFeeds(db, { order: 'published', limit: 3 });

  assert.deepEqual(slugs(rows), ['loud-blog', 'fresh', 'middling']);
});
