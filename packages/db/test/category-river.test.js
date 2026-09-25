import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { connectTest } from '../src/testdb.js';
import * as q from '../src/queries.js';

/**
 * A whole category as a river of what it has just published.
 *
 * The category pages list feeds, which answers "who is in this directory" and
 * not "what is new" — on /podcasts the second is the question being asked, and
 * the ordering there was when we happened to index a show. `latestItems` is the
 * other question, and the shape of the query is the interesting part: it picks
 * the feeds by when they last published and reads items only from those, which
 * is what keeps it off the feeds-to-feed_items aggregate that migration 0030
 * measured at 215 seconds.
 */

let db;

before(async () => {
  db = await connectTest();
});

after(async () => {
  db.close();
});

/**
 * A feed with items in it, and a `last_published_at` the river can pick it by.
 *
 * The column is written by the crawler on a successful fetch, not by
 * insertFeed, so a test that skipped it would be testing an empty river.
 *
 * @param {{ slug: string, kind: string, dates: string[] }} spec
 */
async function publisher({ slug, kind, dates }) {
  const feed = await q.insertFeed(db, {
    slug,
    feed_url: `https://${slug}.example/feed.xml`,
    title: `${slug} show`,
    kind,
  });

  await q.upsertItems(
    db,
    feed.id,
    dates.map((at, i) => ({
      guid: `${slug}-${i}`,
      url: `https://${slug}.example/${i}`,
      title: `${slug} episode ${i}`,
      publishedAt: at,
      audio:
        kind === 'podcast'
          ? { url: `https://${slug}.example/${i}.mp3`, type: 'audio/mpeg' }
          : undefined,
    })),
  );

  const newest = [...dates].sort().at(-1);
  await db.execute({
    sql: 'update feeds set last_published_at = ? where id = ?',
    args: [newest, feed.id],
  });

  return feed;
}

test('the river is newest first across every feed of the kind', async () => {
  await publisher({
    slug: 'slow-show',
    kind: 'podcast',
    dates: [iso(-40), iso(-10)],
  });
  await publisher({
    slug: 'busy-show',
    kind: 'podcast',
    dates: [iso(-30), iso(-2), iso(-1)],
  });

  const rows = await q.latestItems(db, { kinds: ['podcast'], limit: 10 });

  const dates = rows.map((r) => String(r.published_at));
  assert.deepEqual(dates, [...dates].sort().reverse(), 'not newest first');

  // The point of the page: the newest episode belongs to whichever show
  // published it, not to whichever show was indexed last.
  assert.equal(String(rows[0].feed_slug), 'busy-show');
  assert.equal(rows.length, 5);
});

test('a row carries the show it came from, and its artwork', async () => {
  // A list of sixty episodes from sixty shows is unreadable without it, and a
  // river of mixed feeds reads better as a column of pictures than as a column
  // with gaps in it.
  const rows = await q.latestItems(db, { kinds: ['podcast'], limit: 1 });
  const [row] = rows;

  assert.ok(row.feed_slug, 'no feed_slug');
  assert.ok(row.feed_title, 'no feed_title');
  assert.ok('feed_image' in row, 'no feed_image fallback column');
  assert.ok('audio_url' in row, 'no audio, so nothing to press play on');
  assert.equal(String(row.category), 'podcast');
});

test('the filter is by category, not by whatever published most recently', async () => {
  await publisher({ slug: 'a-blog', kind: 'blog', dates: [iso(0)] });

  const podcasts = await q.latestItems(db, { kinds: ['podcast'], limit: 20 });
  assert.ok(
    podcasts.every((row) => String(row.category) === 'podcast'),
    'a blog got into the podcast river',
  );

  // The blog is the newest thing in the directory, so an unfiltered river must
  // lead with it — which is what proves the filter above was doing the work.
  const everything = await q.latestItems(db, { limit: 20 });
  assert.equal(String(everything[0].feed_slug), 'a-blog');
});

test('several kinds can be asked for at once', async () => {
  const audio = await q.latestItems(db, { kinds: ['podcast', 'blog'], limit: 20 });
  const kinds = new Set(audio.map((row) => String(row.category)));

  assert.deepEqual([...kinds].sort(), ['blog', 'podcast']);
});

test('paging walks the river without repeating a row', async () => {
  const first = await q.latestItems(db, { kinds: ['podcast'], limit: 2, offset: 0 });
  const second = await q.latestItems(db, { kinds: ['podcast'], limit: 2, offset: 2 });

  assert.equal(first.length, 2);
  assert.equal(second.length, 2);

  const guids = new Set([...first, ...second].map((row) => String(row.guid)));
  assert.equal(guids.size, 4, 'a row appeared on both pages');

  // Ordered across the page boundary, not only within a page.
  assert.ok(String(first.at(-1).published_at) >= String(second[0].published_at));
});

test('a feed nobody has crawled since 0030 is left out rather than guessed at', async () => {
  // `last_published_at` is null until a feed's next crawl. That is "not known
  // yet", not "never published" — but the river is ordered by it, so a null
  // has no place to go and is honestly absent rather than silently first.
  const feed = await q.insertFeed(db, {
    slug: 'uncrawled-show',
    feed_url: 'https://uncrawled.example/feed.xml',
    title: 'Uncrawled',
    kind: 'podcast',
  });
  await q.upsertItems(db, feed.id, [
    {
      guid: 'uncrawled-0',
      url: 'https://uncrawled.example/0',
      title: 'invisible episode',
      publishedAt: iso(0),
    },
  ]);

  const rows = await q.latestItems(db, { kinds: ['podcast'], limit: 50 });
  assert.ok(
    !rows.some((row) => String(row.feed_slug) === 'uncrawled-show'),
    'a feed with no last_published_at reached the river',
  );
});

test('a dead feed is out of the river even though its archive is still readable', async () => {
  const feed = await publisher({ slug: 'dead-show', kind: 'podcast', dates: [iso(0)] });
  await db.execute({ sql: "update feeds set status = 'dead' where id = ?", args: [feed.id] });

  const rows = await q.latestItems(db, { kinds: ['podcast'], limit: 50 });
  assert.ok(!rows.some((row) => String(row.feed_slug) === 'dead-show'));
});

test('the window is what makes the query affordable, and it excludes old items', async () => {
  await publisher({ slug: 'ancient-show', kind: 'podcast', dates: [iso(-2000)] });

  const rows = await q.latestItems(db, { kinds: ['podcast'], limit: 50 });
  assert.ok(!rows.some((row) => String(row.feed_slug) === 'ancient-show'));

  // Still reachable by asking for a wider one, which is what the option is for.
  const wide = await q.latestItems(db, { kinds: ['podcast'], limit: 50, days: 4000 });
  assert.ok(wide.some((row) => String(row.feed_slug) === 'ancient-show'));
});

test('an unknown kind is the whole directory rather than an empty page', async () => {
  // normalizeKinds drops what it does not recognise and null means every kind,
  // so a caller who guessed a category name gets the directory. Worth pinning:
  // the opposite — silently empty — is the failure nobody reports as a bug.
  const rows = await q.latestItems(db, { kinds: ['not-a-category'], limit: 5 });
  assert.ok(rows.length > 0);
});

/**
 * An ISO timestamp so many days from now.
 *
 * @param {number} days
 * @returns {string}
 */
function iso(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
