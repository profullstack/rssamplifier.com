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

test('search results carry the guid the reader addresses a post by', async () => {
  // Without this the search page has no way to link into /read, and would have
  // to send the reader straight off the site.
  const posts = await q.searchItems(db, 'frogs');
  assert.equal(posts.length, 1);
  assert.equal(String(posts[0].guid), 'a');
});

test('a post outside the newest-N window is still reachable by guid', async () => {
  // The reader lists the newest 200 to build prev/next, but a fifth of what we
  // hold sits past that line and search reaches it. itemByGuid is the escape
  // hatch that keeps those from 404ing.
  const feed = await q.feedByUrl(db, 'https://test.example/feed.xml');
  const id = String(feed.id);

  const window = await q.itemsForFeed(db, id, 1);
  assert.equal(window.length, 1, 'newest-1 window holds only one post');
  assert.equal(String(window[0].guid), 'b', 'newest first');

  // 'a' is now outside the window, but must still resolve.
  assert.equal(
    window.findIndex((r) => String(r.guid) === 'a'),
    -1,
    'the older post really is outside this window',
  );
  const older = await q.itemByGuid(db, id, 'a');
  assert.ok(older, 'itemByGuid reaches past the window');
  assert.equal(String(older.title), 'Alpha post');

  assert.equal(await q.itemByGuid(db, id, 'no-such-guid'), null);
});

test('any-mode search unions the terms instead of intersecting them', async () => {
  // No single post mentions both, so the default must find nothing and
  // any-mode must find both. Anything else and the two modes are the same.
  assert.equal(q.ftsQuery('frogs kites', 'any'), '"frogs" OR "kites"');
  assert.equal(q.ftsQuery('frogs kites'), '"frogs" "kites"', 'default stays AND');

  assert.equal((await q.searchItems(db, 'frogs kites')).length, 0);

  const either = await q.searchItems(db, 'frogs kites', 40, 'any');
  assert.deepEqual(
    either.map((r) => String(r.title)).sort(),
    ['Alpha post', 'Beta post'],
    'any-mode returns the union of both terms',
  );

  // A ticker paired with the name it is usually written under: the point of
  // the mode. The unmatched term must not drag the matched one down with it.
  const paired = await q.searchItems(db, 'zzzznotaticker frogs', 40, 'any');
  assert.equal(paired.length, 1);
  assert.equal(String(paired[0].title), 'Alpha post');

  // Escaping still applies, so operators stay literal in either mode.
  assert.equal(q.ftsQuery('a OR b', 'any'), '"a" OR "OR" OR "b"');
  for (const bad of ['C++', 'a OR b', '*', 'NEAR(a b)']) {
    await q.searchItems(db, bad, 40, 'any');
  }
});

test('any-mode blog search behaves the same way', async () => {
  const blogs = await q.searchFeeds(db, 'testing zzzznotablog', 20, 'any');
  assert.equal(blogs.length, 1);
  assert.equal(String(blogs[0].slug), 'test-blog');

  assert.equal((await q.searchFeeds(db, 'testing zzzznotablog')).length, 0, 'default still AND');
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

test('eachFeedForExport yields the whole directory, not one page of it', async () => {
  const exportDir = await mkdtemp(join(tmpdir(), 'rssamp-export-'));
  const exportDb = connect({ url: `file:${join(exportDir, 'test.db')}` });
  await migrate(exportDb);

  // Titles deliberately collide: the export cursor is (title, id), and a cursor
  // on title alone would either skip or repeat rows wherever a page boundary
  // lands inside a run of the same title.
  const total = 25;
  for (let i = 0; i < total; i += 1) {
    await q.insertFeed(exportDb, {
      slug: `blog-${String(i).padStart(3, '0')}`,
      feed_url: `https://blog-${i}.example/feed.xml`,
      site_url: `https://blog-${i}.example/`,
      title: i % 5 === 0 ? 'Shared Title' : `Blog ${String(i).padStart(3, '0')}`,
      description: null,
    });
  }

  const seen = [];
  for await (const row of q.eachFeedForExport(exportDb, 4)) seen.push(String(row.slug));

  assert.equal(seen.length, total, 'every feed came back across page boundaries');
  assert.equal(new Set(seen).size, total, 'no feed was yielded twice');

  const titles = [];
  for await (const row of q.eachFeedForExport(exportDb, 4)) titles.push(String(row.title));
  assert.deepEqual(titles, [...titles].sort(), 'paging preserved the title ordering');

  // A page larger than the table must still terminate, and dead feeds stay out.
  await exportDb.execute("update feeds set status = 'dead' where slug = 'blog-001'");
  const alive = [];
  for await (const row of q.eachFeedForExport(exportDb, 500)) alive.push(String(row.slug));
  assert.equal(alive.length, total - 1);
  assert.equal(alive.includes('blog-001'), false, 'dead feeds are excluded from exports');

  await rm(exportDir, { recursive: true, force: true });
});

test('monthBounds is a half-open range and rolls over December', () => {
  assert.deepEqual(q.monthBounds('2026-08'), { from: '2026-08-', to: '2026-09-' });
  assert.deepEqual(q.monthBounds('2026-12'), { from: '2026-12-', to: '2027-01-' });
  assert.deepEqual(q.monthBounds('2026-09'), { from: '2026-09-', to: '2026-10-' });
});

test('sitemap chunks split an oversized month and cover it exactly once', async () => {
  const chunkDir = await mkdtemp(join(tmpdir(), 'rssamp-sitemap-'));
  const chunkDb = connect({ url: `file:${join(chunkDir, 'test.db')}` });
  await migrate(chunkDb);

  // Two months, one of them far larger than the chunk size — the shape a bulk
  // import leaves behind, where a single month holds the whole directory.
  const seed = [
    { month: '2026-07', n: 4 },
    { month: '2026-08', n: 25 },
  ];
  let i = 0;
  for (const { month, n } of seed) {
    for (let k = 0; k < n; k += 1) {
      const { id } = await q.insertFeed(chunkDb, {
        slug: `feed-${i}`,
        feed_url: `https://f${i}.example/feed.xml`,
        site_url: null,
        title: `Feed ${i}`,
        description: null,
      });
      // Every row in a month shares a timestamp, as a bulk insert would leave it.
      await chunkDb.execute({
        sql: 'update feeds set created_at = ? where id = ?',
        args: [`${month}-01T00:00:00.000Z`, id],
      });
      i += 1;
    }
  }

  const chunks = await q.sitemapChunks(chunkDb, 10);
  assert.deepEqual(
    chunks.map((c) => `${c.month}#${c.part}:${c.count}`),
    ['2026-07#1:4', '2026-08#1:10', '2026-08#2:10', '2026-08#3:5'],
    'the big month split into parts, the small one did not',
  );
  assert.equal(
    chunks.reduce((sum, c) => sum + c.count, 0),
    29,
    'the parts add up to the directory',
  );

  const seen = [];
  for (const chunk of chunks) {
    const rows = await q.feedsForSitemapChunk(chunkDb, { ...chunk, chunkSize: 10 });
    assert.equal(rows.length, chunk.count, `${chunk.month} part ${chunk.part} is the promised size`);
    seen.push(...rows.map((r) => String(r.slug)));
  }

  assert.equal(seen.length, 29, 'every feed appeared');
  assert.equal(new Set(seen).size, 29, 'no feed appeared in two chunks');

  // A month nobody has feeds in yields nothing rather than leaking the next month.
  const empty = await q.feedsForSitemapChunk(chunkDb, { month: '2026-06', chunkSize: 10 });
  assert.equal(empty.length, 0);

  await rm(chunkDir, { recursive: true, force: true });
});

test('newId is unique and nowIso offsets correctly', () => {
  assert.notEqual(newId(), newId());
  const later = new Date(nowIso(60_000)).getTime() - new Date(nowIso()).getTime();
  assert.ok(later > 55_000 && later < 65_000, `offset was ${later}ms`);
});
