import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, newId, nowIso } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as accounts from '../src/accounts.js';
import * as dataset from '../src/dataset.js';

/**
 * The corpus gate, the cadence limits, and the publisher's veto.
 *
 * Seeded with raw inserts rather than through `q.insertFeed` and `q.upsertItems`
 * on purpose. Those helpers carry their own coercions — `upsertItems` silently
 * ignores a field it does not recognise — and a test that goes through them is
 * testing them as much as the thing under test. Here the point is exactly which
 * rows come back out of a stream, so exactly which rows went in has to be beyond
 * question.
 */

let dir;
let db;
let buyer;

/** Two windows apart, so a slice can be shown to exclude what is outside it. */
const EARLY = '2026-08-29T04:30:00.000Z';
const LATE = '2026-08-29T09:15:00.000Z';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-dataset-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
  buyer = await accounts.findOrCreateUser(db, 'buyer@example.com');

  await seedFeed('open', 0, EARLY);
  await seedFeed('shy', 1, EARLY);
  await seedFeed('late', 0, LATE);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A feed, one post on it, and one extracted article for that post.
 *
 * @param {string} slug
 * @param {number} optOut
 * @param {string} at
 */
async function seedFeed(slug, optOut, at) {
  const feedId = `feed-${slug}`;
  const itemId = `item-${slug}`;

  await db.execute({
    sql: `insert into feeds (id, slug, feed_url, site_url, title, status, next_fetch_at,
                             created_at, updated_at, dataset_opt_out)
          values (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    args: [
      feedId,
      slug,
      `https://${slug}.example/feed.xml`,
      `https://${slug}.example/`,
      `The ${slug} blog`,
      at,
      at,
      at,
      optOut,
    ],
  });

  await db.execute({
    sql: `insert into feed_items (id, feed_id, guid, url, title, summary, created_at, published_at)
          values (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      itemId,
      feedId,
      `guid-${slug}`,
      `https://${slug}.example/post`,
      `A post on ${slug}`,
      'summary',
      at,
      at,
    ],
  });

  await db.execute({
    sql: `insert into item_extracts (item_id, url, title, content_html, text_length, status, fetched_at)
          values (?, ?, ?, ?, ?, 'ok', ?)`,
    args: [itemId, `https://${slug}.example/post`, `A post on ${slug}`, '<p>words</p>', 5, at],
  });
}

/**
 * @param {AsyncGenerator<object>} stream
 * @returns {Promise<object[]>}
 */
async function drain(stream) {
  const rows = [];
  for await (const row of stream) rows.push(row);
  return rows;
}

/**
 * @param {object} [overrides]
 */
function grantTo(userId, overrides = {}) {
  const id = newId();
  return db
    .execute({
      sql: `insert into dataset_grants
              (id, user_id, plan, per_window_downloads, full_dumps_per_day, granted_at, expires_at, revoked_at)
            values (?, ?, 'evaluation', ?, ?, ?, ?, ?)`,
      args: [
        id,
        userId,
        overrides.perWindow ?? 3,
        overrides.fullPerDay ?? 1,
        overrides.grantedAt ?? nowIso(),
        overrides.expiresAt ?? null,
        overrides.revokedAt ?? null,
      ],
    })
    .then(() => id);
}

// ---------------------------------------------------------------- the gate

test('an account with no grant has no licence', async () => {
  assert.equal(await dataset.activeGrant(db, String(buyer.id)), null);
});

test('a live grant is found', async () => {
  await grantTo(String(buyer.id));
  const grant = await dataset.activeGrant(db, String(buyer.id));
  assert.ok(grant);
  assert.equal(grant.plan, 'evaluation');
});

test('an expired grant stops opening the gate without anything having to run', async () => {
  const user = await accounts.findOrCreateUser(db, 'expired@example.com');
  await grantTo(String(user.id), { expiresAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(await dataset.activeGrant(db, String(user.id)), null);
});

test('a revoked grant stops opening the gate', async () => {
  const user = await accounts.findOrCreateUser(db, 'revoked@example.com');
  await grantTo(String(user.id), { revokedAt: nowIso() });
  assert.equal(await dataset.activeGrant(db, String(user.id)), null);
});

test('a renewal beside a lapsed grant wins, without anyone tidying the old one', async () => {
  const user = await accounts.findOrCreateUser(db, 'renewed@example.com');
  await grantTo(String(user.id), {
    grantedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-02-01T00:00:00.000Z',
  });
  const fresh = await grantTo(String(user.id), { grantedAt: nowIso() });

  const grant = await dataset.activeGrant(db, String(user.id));
  assert.equal(String(grant.id), fresh);
  // Both are still on the account page, which is how "my access stopped" gets
  // answered by a date rather than by an email.
  assert.equal((await dataset.grantsForUser(db, String(user.id))).length, 2);
});

// ---------------------------------------------------------------- cadence

test('a pull counts against its window as soon as it starts, not when it finishes', async () => {
  const user = await accounts.findOrCreateUser(db, 'cadence@example.com');
  const grantId = await grantTo(String(user.id));
  const window = '2026-08-29T04:00:00.000Z';

  const id = await dataset.startDownload(db, {
    grantId,
    userId: String(user.id),
    dataset: 'items',
    windowStart: window,
  });

  // Never finished — the connection died. It still counts, or hanging up would
  // be a free way to run the query in a loop.
  assert.equal(await dataset.windowDownloadCount(db, grantId, 'items', window), 1);

  await dataset.finishDownload(db, id, 42);
  const [row] = await dataset.recentDownloads(db, grantId, 1);
  assert.equal(Number(row.rows_sent), 42);
  assert.ok(row.completed_at);
});

test('the window count is per dataset and per window, not per licence', async () => {
  const user = await accounts.findOrCreateUser(db, 'perwindow@example.com');
  const grantId = await grantTo(String(user.id));

  await dataset.startDownload(db, {
    grantId,
    userId: String(user.id),
    dataset: 'items',
    windowStart: '2026-08-29T04:00:00.000Z',
  });

  // Same licence, same window, different dataset: untouched.
  assert.equal(
    await dataset.windowDownloadCount(db, grantId, 'extracts', '2026-08-29T04:00:00.000Z'),
    0,
  );
  // Same licence, same dataset, next window: untouched. This is the whole point
  // of the cadence — the allowance renews on the clock rather than on a timer
  // started by the last request.
  assert.equal(
    await dataset.windowDownloadCount(db, grantId, 'items', '2026-08-29T08:00:00.000Z'),
    0,
  );
});

test('full dumps are counted apart from windowed pulls', async () => {
  const user = await accounts.findOrCreateUser(db, 'full@example.com');
  const grantId = await grantTo(String(user.id));
  const dayStart = '2026-08-29T00:00:00.000Z';

  await dataset.startDownload(db, {
    grantId,
    userId: String(user.id),
    dataset: 'items',
    windowStart: '2026-08-29T04:00:00.000Z',
  });
  assert.equal(await dataset.fullDumpCount(db, grantId, dayStart), 0);

  await dataset.startDownload(db, {
    grantId,
    userId: String(user.id),
    dataset: 'items',
    windowStart: null,
    fullDump: true,
  });
  assert.equal(await dataset.fullDumpCount(db, grantId, dayStart), 1);
  // Yesterday's full dump must not spend today's allowance.
  assert.equal(await dataset.fullDumpCount(db, grantId, '2099-01-01T00:00:00.000Z'), 0);
});

// ---------------------------------------------------------------- opt-out

test('an opted-out feed is absent from the feeds stream', async () => {
  const slugs = (await drain(dataset.eachDatasetFeed(db, {}))).map((r) => String(r.slug));
  assert.deepEqual(slugs.sort(), ['late', 'open']);
});

test('its posts are absent too, through the feed rather than a flag of their own', async () => {
  const ids = (await drain(dataset.eachDatasetItem(db, {}))).map((r) => String(r.id));
  assert.ok(!ids.includes('item-shy'));
  assert.ok(ids.includes('item-open'));
});

test('and so are its articles, which are two joins away from the flag', async () => {
  // The one most likely to be missed: `item_extracts` reaches `feeds` only
  // through `feed_items`, so an opt-out that stopped at the post would leave the
  // publisher's actual prose in the corpus — the exact thing they asked us not
  // to sell.
  const ids = (await drain(dataset.eachDatasetExtract(db, {}))).map((r) => String(r.item_id));
  assert.ok(!ids.includes('item-shy'));
  assert.ok(ids.includes('item-open'));
});

test('opting out and back in is a single call, keyed on the public slug', async () => {
  assert.equal(await dataset.optedOutCount(db), 1);

  assert.equal(await dataset.setDatasetOptOut(db, 'open', true), true);
  assert.equal(await dataset.optedOutCount(db), 2);
  // Idempotent: setting it again changes nothing and says so.
  assert.equal(await dataset.setDatasetOptOut(db, 'open', true), false);

  assert.equal(await dataset.setDatasetOptOut(db, 'open', false), true);
  assert.equal(await dataset.optedOutCount(db), 1);
});

// ---------------------------------------------------------------- slicing

test('a window excludes what falls outside it, on every stream', async () => {
  const slice = { since: '2026-08-29T08:00:00.000Z', until: '2026-08-29T12:00:00.000Z' };

  assert.deepEqual(
    (await drain(dataset.eachDatasetFeed(db, slice))).map((r) => String(r.slug)),
    ['late'],
  );
  assert.deepEqual(
    (await drain(dataset.eachDatasetItem(db, slice))).map((r) => String(r.id)),
    ['item-late'],
  );
  assert.deepEqual(
    (await drain(dataset.eachDatasetExtract(db, slice))).map((r) => String(r.item_id)),
    ['item-late'],
  );
});

test('the range is half-open, so a row on the boundary belongs to one window only', async () => {
  const boundary = '2026-08-29T08:00:00.000Z';
  await seedFeed('boundary', 0, boundary);

  const before = await drain(
    dataset.eachDatasetItem(db, { since: '2026-08-29T04:00:00.000Z', until: boundary }),
  );
  const after = await drain(
    dataset.eachDatasetItem(db, { since: boundary, until: '2026-08-29T12:00:00.000Z' }),
  );

  const ids = (rows) => rows.map((r) => String(r.id));
  assert.ok(!ids(before).includes('item-boundary'));
  assert.ok(ids(after).includes('item-boundary'));
});

test('a post carries the slug of the feed it came from', async () => {
  // Without this a post record refers to its feed by an opaque id the buyer
  // cannot resolve unless they happened to take the feeds stream the same day.
  const [post] = (await drain(dataset.eachDatasetItem(db, {}))).filter(
    (r) => String(r.id) === 'item-open',
  );
  assert.equal(String(post.feed_slug), 'open');
  assert.equal(String(post.feed_url), 'https://open.example/feed.xml');
});

test('the keyset cursor pages without dropping or repeating a row', async () => {
  // The failure this guards against is the quiet one: a cursor that skips the
  // row after a page boundary loses exactly one row per page, which on a
  // four-row fixture is obvious and on a four-million-row dump is invisible.
  const whole = await drain(dataset.eachDatasetItem(db, {}));
  const paged = await drain(dataset.eachDatasetItem(db, { pageSize: 1 }));

  assert.deepEqual(
    paged.map((r) => String(r.id)),
    whole.map((r) => String(r.id)),
  );
  assert.equal(new Set(paged.map((r) => String(r.id))).size, paged.length);
});

test('rows arrive in the order the window is cut on', async () => {
  const rows = await drain(dataset.eachDatasetItem(db, { pageSize: 1 }));
  const stamps = rows.map((r) => String(r.created_at));
  assert.deepEqual(stamps, [...stamps].sort());
});

// ---------------------------------------------------------------- authors

test('an author arrives with their links parsed apart, and never with their address', async () => {
  // This test exists because its absence shipped a bug. The authors stream was
  // written against a column called `kind` that `author_links` does not have —
  // it is `network` — and every other test here passed, because none of them
  // ever put an author in the fixture. An empty table cannot fail a query.
  await db.execute({
    sql: `insert into authors (id, slug, identity_key, name, norm_name, email, confidence, created_at, updated_at)
          values ('a1', 'jane', 'https://jane.example/', 'Jane', 'jane', 'jane@jane.example', 0.9, ?, ?)`,
    args: [EARLY, EARLY],
  });
  await db.execute({
    sql: `insert into author_links (id, author_id, network, url, handle, source, verified, created_at)
          values ('l1', 'a1', 'mastodon', 'https://social.example/@jane', '@jane', 'rel-me', 1, ?)`,
    args: [EARLY],
  });

  const [author] = await drain(dataset.eachDatasetAuthor(db, {}));
  assert.equal(String(author.slug), 'jane');

  const links = JSON.parse(String(author.links));
  assert.equal(links.length, 1);
  assert.equal(links[0].network, 'mastodon');
  assert.equal(links[0].handle, '@jane');
  // Verified travels with the link, or a guess and a proof look identical.
  assert.equal(links[0].verified, 1);

  // The one exclusion that is ours rather than the publisher's. The column
  // holds addresses people published as their own contact, and a corpus of
  // contactable humans is a different product from a corpus of their writing.
  assert.ok(!('email' in author), 'authors.email must never leave in the corpus');
});

// ---------------------------------------------------------------- figures

test('the article sample stays small enough to actually complete', async () => {
  // A bound rather than an equality, because the number itself is a judgement
  // call and may reasonably move. What must not move is the order of magnitude.
  //
  // `text_length` is covered by no index, so this read costs one row lookup per
  // sampled row and nothing else: 2,000 measured at 584ms against production
  // where 20,000 measured at 22,662ms. The second number exceeded the caller's
  // timeout, and because a read-through cache stores nothing on failure, the two
  // figures this feeds were absent from /sales permanently rather than briefly.
  //
  // So this guards the failure that actually happened. Raising the sample past
  // this bound does not make the page slower — it makes it empty.
  const figures = await dataset.articleFigures(db);

  assert.ok(
    figures.sampleSize <= 5_000,
    `sample of ${figures.sampleSize} risks exceeding the caller's timeout; see the note on articleFigures`,
  );
  // Reported alongside the average so the page can say "sampled over N" rather
  // than presenting an estimate as a total.
  assert.equal(typeof figures.sampledAvgChars, 'number');
  assert.equal(figures.articles, 4, 'one ok extract per seeded feed');
});

// ---------------------------------------------------------------- enquiries

test('an enquiry is stored, and repeats from one address are countable', async () => {
  const before = await dataset.enquiryCountFrom(db, 'hash-1', '2000-01-01T00:00:00.000Z');
  assert.equal(before, 0);

  await dataset.insertEnquiry(db, {
    email: 'lab@example.com',
    useCase: 'pretraining a small model on independent writing',
    ipHash: 'hash-1',
  });

  assert.equal(await dataset.enquiryCountFrom(db, 'hash-1', '2000-01-01T00:00:00.000Z'), 1);
  // A different sender is not throttled by this one's history.
  assert.equal(await dataset.enquiryCountFrom(db, 'hash-2', '2000-01-01T00:00:00.000Z'), 0);
  // No address to count against is not an error, and must not read as a flood.
  assert.equal(await dataset.enquiryCountFrom(db, null, '2000-01-01T00:00:00.000Z'), 0);
});
