import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import { creditStatements, upsertAuthor } from '../src/authors.js';

/**
 * Two crawls claiming the same author slug must not fail a feed.
 *
 * `claimAuthorSlug` reads the slugs already taken and the insert runs later, so
 * two feeds naming the same author can both pick `jane-doe` before either has
 * committed. The loser used to violate `authors.slug` — and because the insert
 * rides in the crawl's own write transaction, it took the whole crawl with it:
 * the feed was recorded `could not be crawled` and walked up the backoff ladder
 * toward `dead`, over a byline.
 *
 * Seen in production on 2026-08-19: two Substack feeds failed every crawl for
 * hours on exactly this.
 */

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-slug-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);

  // feed_authors carries a foreign key to feeds, so the credits have to have
  // somewhere to land.
  const now = '2026-01-01T00:00:00.000Z';
  for (const [id, slug] of [
    ['feed-1', 'one'],
    ['feed-2', 'two'],
  ]) {
    await db.execute({
      sql: `insert into feeds (id, slug, title, feed_url, status, next_fetch_at, created_at, updated_at)
            values (?, ?, ?, ?, 'active', ?, ?, ?)`,
      args: [id, slug, slug, `https://${slug}.example/feed`, now, now, now],
    });
  }
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const person = (name, email) => ({
  name,
  normName: name.toLowerCase(),
  bio: '',
  avatarUrl: '',
  siteUrl: '',
  email,
  confidence: 0.8,
  role: 'author',
  evidence: 'test',
});

test('a second person claiming a taken slug does not fail the write', async () => {
  const first = creditStatements({
    feedId: 'feed-1',
    identityKey: 'jane@one.example',
    slug: 'jane-doe',
    person: person('Jane Doe', 'jane@one.example'),
  });
  await db.batch(first, 'write');

  // A different identity — so the identity_key upsert does not catch it — that
  // raced to the same slug.
  const second = creditStatements({
    feedId: 'feed-2',
    identityKey: 'jane@two.example',
    slug: 'jane-doe',
    person: person('Jane Doe', 'jane@two.example'),
  });

  await assert.doesNotReject(
    () => db.batch(second, 'write'),
    'a slug collision must not take the crawl down',
  );
});

test('the first claimant keeps the slug, unaltered', async () => {
  const { rows } = await db.execute({
    sql: 'select identity_key, email from authors where slug = ?',
    args: ['jane-doe'],
  });

  assert.equal(rows.length, 1, 'exactly one author may hold a slug');
  assert.equal(String(rows[0].identity_key), 'jane@one.example');
  assert.equal(String(rows[0].email), 'jane@one.example', 'the loser must not overwrite the winner');
});

test('the loser is not created, so a later crawl can claim a free slug', async () => {
  // Not lost, deferred. By the next crawl the slug is taken, so
  // `claimAuthorSlug` picks the next free one and the credit lands then.
  const { rows } = await db.execute({
    sql: 'select count(*) as n from authors where identity_key = ?',
    args: ['jane@two.example'],
  });

  assert.equal(Number(rows[0].n), 0);
});

test('the same person crawled twice still updates, rather than being skipped', async () => {
  // The guard must not swallow the ordinary path: a matching identity_key is an
  // update, and only a *different* identity colliding on slug is a no-op.
  const better = creditStatements({
    feedId: 'feed-1',
    identityKey: 'jane@one.example',
    slug: 'jane-doe',
    person: { ...person('Jane Doe', 'jane@one.example'), bio: 'Writes things.', confidence: 0.95 },
  });
  await db.batch(better, 'write');

  const { rows } = await db.execute({
    sql: 'select bio, confidence from authors where identity_key = ?',
    args: ['jane@one.example'],
  });

  assert.equal(String(rows[0].bio), 'Writes things.');
  assert.equal(Number(rows[0].confidence), 0.95);
});

test('upsertAuthor survives the same race', async () => {
  // The enrichment pass takes the other path into this table.
  await upsertAuthor(db, {
    identityKey: 'sam@one.example',
    slug: 'sam-smith',
    name: 'Sam Smith',
    normName: 'sam smith',
    confidence: 0.5,
  });

  await assert.doesNotReject(() =>
    upsertAuthor(db, {
      identityKey: 'sam@two.example',
      slug: 'sam-smith',
      name: 'Sam Smith',
      normName: 'sam smith',
      confidence: 0.5,
    }),
  );

  const { rows } = await db.execute({
    sql: 'select count(*) as n from authors where slug = ?',
    args: ['sam-smith'],
  });
  assert.equal(Number(rows[0].n), 1);
});
