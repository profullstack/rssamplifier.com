import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, newId, nowIso } from '../src/client.js';
import { migrate, splitStatements } from '../src/migrate.js';
import * as q from '../src/queries.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('splitStatements keeps trigger bodies intact', () => {
  const sql = `
create table t (a text);
create trigger t_ai after insert on t begin
  insert into other (a) values (new.a);
  insert into more (a) values (new.a);
end;
create index i on t (a);
`;
  const parts = splitStatements(sql);
  assert.equal(parts.length, 3, `expected 3 statements, got ${parts.length}`);
  assert.ok(parts[1].includes('begin'), 'trigger kept its body');
  assert.ok(parts[1].trimEnd().endsWith('end;'), 'trigger was not cut at an inner semicolon');
  assert.ok(parts[2].startsWith('create index'));
});

test('migrate is idempotent', async () => {
  const again = await migrate(db);
  assert.equal(again.applied.length, 0, 'nothing re-applied');
  assert.ok(again.skipped.includes('0001_init.sql'));
});

test('insert a feed and read it back by slug and url', async () => {
  const { id, slug } = await q.insertFeed(db, {
    slug: 'test-blog',
    feed_url: 'https://test.example/feed.xml',
    site_url: 'https://test.example/',
    title: 'Test Blog',
    description: 'A blog for testing',
  });

  assert.equal(slug, 'test-blog');

  const bySlug = await q.feedBySlug(db, 'test-blog');
  assert.equal(bySlug.title, 'Test Blog');
  assert.equal(String(bySlug.id), id);

  const byUrl = await q.feedByUrl(db, 'https://test.example/feed.xml');
  assert.equal(String(byUrl.id), id);

  assert.equal(await q.feedBySlug(db, 'nope'), null);
});

test('items insert, dedupe by guid, and count', async () => {
  const feed = await q.feedByUrl(db, 'https://test.example/feed.xml');
  const id = String(feed.id);

  const items = [
    { guid: 'a', title: 'Alpha post', summary: 'about frogs', publishedAt: '2026-08-01T00:00:00Z' },
    { guid: 'b', title: 'Beta post', summary: 'about kites', publishedAt: '2026-08-02T00:00:00Z' },
  ];

  await q.upsertItems(db, id, items);
  assert.equal(await q.countItems(db, id), 2);

  // Re-inserting the same guids must not duplicate.
  await q.upsertItems(db, id, items);
  assert.equal(await q.countItems(db, id), 2, 'duplicate guids ignored');

  const rows = await q.itemsForFeed(db, id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Beta post', 'newest first');
});

test('items without a guid are skipped rather than inserted blank', async () => {
  const feed = await q.feedByUrl(db, 'https://test.example/feed.xml');
  const id = String(feed.id);
  const before = await q.countItems(db, id);

  await q.upsertItems(db, id, [{ guid: '', title: 'No guid' }]);
  assert.equal(await q.countItems(db, id), before);
});

test('full-text search finds posts and blogs', async () => {
  const posts = await q.searchItems(db, 'frogs');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, 'Alpha post');
  assert.equal(posts[0].feed_slug, 'test-blog');

  const blogs = await q.searchFeeds(db, 'testing');
  assert.equal(blogs.length, 1);
  assert.equal(blogs[0].slug, 'test-blog');

  assert.deepEqual(await q.searchItems(db, 'nothingmatchesthis'), []);
});

test('FTS index follows updates and deletes', async () => {
  const { id } = await q.insertFeed(db, {
    slug: 'temp-blog',
    feed_url: 'https://temp.example/feed',
    title: 'Temp Blog',
    description: 'unique-marker-word',
  });

  assert.equal((await q.searchFeeds(db, 'unique-marker-word')).length, 1);

  await db.execute({ sql: 'delete from feeds where id = ?', args: [id] });
  assert.equal(
    (await q.searchFeeds(db, 'unique-marker-word')).length,
    0,
    'delete trigger must clear the external-content index',
  );
});

test('ftsQuery neutralises FTS5 syntax so odd queries do not throw', async () => {
  assert.equal(q.ftsQuery('C++'), '"C++"');
  assert.equal(q.ftsQuery('foo AND'), '"foo" "AND"');
  assert.equal(q.ftsQuery('say "hi"'), '"say" """hi"""');
  assert.equal(q.ftsQuery('   '), '');

  // The real test: these must not raise an FTS5 syntax error.
  for (const bad of ['C++', 'foo AND', 'a OR b', '"', '*', 'NEAR(a b)']) {
    await q.searchItems(db, bad);
  }
});

test('slug collision helper returns the existing family', async () => {
  const taken = await q.takenSlugs(db, 'test-blog');
  assert.ok(taken.has('test-blog'));
});

test('due feeds respect next_fetch_at', async () => {
  const due = await q.dueFeeds(db, 10);
  assert.equal(due.length, 0, 'freshly inserted feeds are scheduled an hour out');

  await db.execute({
    sql: 'update feeds set next_fetch_at = ? where slug = ?',
    args: [nowIso(-60_000), 'test-blog'],
  });

  const now = await q.dueFeeds(db, 10);
  assert.equal(now.length, 1);
});

test('crawl failure backs off and eventually marks the feed dead', async () => {
  const feed = await q.feedBySlug(db, 'test-blog');
  const id = String(feed.id);

  await q.markCrawlFailure(db, id, 'timeout', 1, 60);
  let row = await q.feedBySlug(db, 'test-blog');
  assert.equal(row.status, 'error');
  assert.equal(Number(row.error_count), 1);

  await q.markCrawlFailure(db, id, 'timeout', 10, 1440);
  row = await q.feedBySlug(db, 'test-blog');
  assert.equal(row.status, 'dead', 'ten consecutive failures retires the feed');

  // A dead feed must drop out of the crawl queue and the public listing.
  await db.execute({
    sql: 'update feeds set next_fetch_at = ? where id = ?',
    args: [nowIso(-60_000), id],
  });
  assert.equal((await q.dueFeeds(db, 10)).length, 0, 'dead feeds are not re-crawled');
  assert.equal(
    (await q.listFeeds(db)).some((f) => f.slug === 'test-blog'),
    false,
    'dead feeds are hidden from the index',
  );
});

test('submission audit and rate-limit window', async () => {
  const ip = 'hash-abc';
  assert.equal(await q.submissionCount(db, ip), 0);

  await q.insertSubmission(db, { kind: 'url', raw_input: 'x.example', ip_hash: ip });
  await q.insertSubmission(db, { kind: 'url', raw_input: 'y.example', ip_hash: ip });

  assert.equal(await q.submissionCount(db, ip), 2);
  assert.equal(await q.submissionCount(db, 'someone-else'), 0);
});

test('newId is unique and nowIso offsets correctly', () => {
  assert.notEqual(newId(), newId());
  const later = new Date(nowIso(60_000)).getTime() - new Date(nowIso()).getTime();
  assert.ok(later > 55_000 && later < 65_000, `offset was ${later}ms`);
});
