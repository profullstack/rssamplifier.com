import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q, accounts, alerts, authors } from '../index.js';

/**
 * Following a person, and being told when they publish.
 *
 * The third kind of follow, after the blog (0003) and the topic (0021). What
 * makes it worth its own table rather than a flag on either is the thing these
 * tests are mostly about: a person is not a publication, so a follow on one has
 * to keep working when they publish somewhere new.
 */

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-author-follows-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * @param {string} slug
 * @param {Array<{ guid: string, title: string, publishedAt?: string }>} [items]
 */
async function feedWith(slug, items = []) {
  const feed = await q.insertFeed(db, {
    slug,
    feed_url: `https://${slug}.example/feed.xml`,
    site_url: `https://${slug}.example/`,
    title: `${slug} blog`,
    kind: 'blog',
    status: 'active',
  });
  if (items.length) await q.upsertItems(db, String(feed.id), items);
  return feed;
}

/**
 * @param {string} slug
 * @param {string} name
 */
async function personCalled(slug, name) {
  const { id } = await authors.upsertAuthor(db, {
    identityKey: `mailto:${slug}@example.com`,
    slug,
    name,
    normName: name.toLowerCase(),
    confidence: 0.9,
  });
  return String(id);
}

test('following a person is idempotent, and unfollowing removes it', async () => {
  const user = await accounts.findOrCreateUser(db, 'follows@example.com');
  const ada = await personCalled('ada-lovelace', 'Ada Lovelace');

  await accounts.followAuthor(db, user.id, ada);
  // Twice over: a double submit must not become a constraint error or a second
  // row, the same guarantee the topic follows make.
  await accounts.followAuthor(db, user.id, ada);

  assert.equal(await accounts.isFollowingAuthor(db, user.id, ada), true);
  assert.equal((await accounts.followedAuthors(db, user.id)).length, 1);
  assert.equal(await accounts.authorFollowerCount(db, ada), 1);

  await accounts.unfollowAuthor(db, user.id, ada);
  assert.equal(await accounts.isFollowingAuthor(db, user.id, ada), false);
  assert.equal((await accounts.followedAuthors(db, user.id)).length, 0);
});

test('a followed person carries their name and how much they publish', async () => {
  const user = await accounts.findOrCreateUser(db, 'named@example.com');
  const grace = await personCalled('grace-hopper', 'Grace Hopper');

  const blog = await feedWith('grace-blog');
  const pod = await feedWith('grace-pod');
  await authors.linkFeedAuthor(db, String(blog.id), grace, { role: 'owner', confidence: 0.9 });
  await authors.linkFeedAuthor(db, String(pod.id), grace, { role: 'owner', confidence: 0.9 });

  await accounts.followAuthor(db, user.id, grace);
  const [row] = await accounts.followedAuthors(db, user.id);

  // Joined back rather than copied into the follow: the extractor improves its
  // answer over time and a copy here would be a copy to keep in step.
  assert.equal(String(row.name), 'Grace Hopper');
  assert.equal(String(row.slug), 'grace-hopper');
  assert.equal(Number(row.feed_count), 2);
});

test('alerts are off until asked for, and only on a follow that exists', async () => {
  const user = await accounts.findOrCreateUser(db, 'bell@example.com');
  const ada = await personCalled('ada-two', 'Ada Two');

  // Nothing to flag: the bell must refuse rather than quietly create a follow,
  // which is the whole distinction between the button and the bell.
  assert.equal(await alerts.setAuthorAlerts(db, user.id, ada, true), false);
  assert.deepEqual(await alerts.authorFollowState(db, user.id, ada), {
    following: false,
    alerts: false,
  });

  await accounts.followAuthor(db, user.id, ada);
  assert.deepEqual(await alerts.authorFollowState(db, user.id, ada), {
    following: true,
    alerts: false,
  });

  assert.equal(await alerts.setAuthorAlerts(db, user.id, ada, true), true);
  assert.deepEqual(await alerts.authorFollowState(db, user.id, ada), {
    following: true,
    alerts: true,
  });

  const listed = await alerts.alertingFollows(db, user.id);
  assert.deepEqual(
    listed.authors.map((a) => String(a.name)),
    ['Ada Two'],
  );
});

test('an alerting person yields their new posts from every feed they write', async () => {
  const user = await accounts.findOrCreateUser(db, 'items@example.com');
  const alan = await personCalled('alan-turing', 'Alan Turing');

  const blog = await feedWith('alan-blog', [{ guid: 't1', title: 'On the blog' }]);
  const pod = await feedWith('alan-pod', [{ guid: 't2', title: 'On the podcast' }]);
  await authors.linkFeedAuthor(db, String(blog.id), alan, { role: 'owner', confidence: 0.9 });
  await authors.linkFeedAuthor(db, String(pod.id), alan, { role: 'owner', confidence: 0.9 });

  await accounts.followAuthor(db, user.id, alan);
  await alerts.setAuthorAlerts(db, user.id, alan, true);

  const alerting = await alerts.alertedAuthors(db, user.id);
  assert.equal(alerting.length, 1);
  assert.equal(String(alerting[0].id), alan);

  // From the beginning of time, so everything seeded above is "new".
  const rows = await alerts.newItemsForAuthor(db, alan, '1970-01-01T00:00:00.000Z');

  assert.deepEqual(
    rows.map((r) => String(r.title)).sort(),
    ['On the blog', 'On the podcast'],
    'both publications, which is the point of following the person',
  );

  // Nothing is new once the watermark has passed it. A far-future cursor stands
  // in for "already told about all of this".
  const none = await alerts.newItemsForAuthor(db, alan, '2999-01-01T00:00:00.000Z');
  assert.equal(none.length, 0);
});

test('a dead feed contributes nothing, so a move is not announced as new writing', async () => {
  const user = await accounts.findOrCreateUser(db, 'dead@example.com');
  const kay = await personCalled('alan-kay', 'Alan Kay');

  const gone = await feedWith('kay-old', [{ guid: 'k1', title: 'From the old blog' }]);
  await db.execute({ sql: `update feeds set status = 'dead' where id = ?`, args: [String(gone.id)] });
  await authors.linkFeedAuthor(db, String(gone.id), kay, { role: 'owner', confidence: 0.9 });

  await accounts.followAuthor(db, user.id, kay);
  await alerts.setAuthorAlerts(db, user.id, kay, true);

  const rows = await alerts.newItemsForAuthor(db, kay, '1970-01-01T00:00:00.000Z');
  assert.equal(rows.length, 0);
});

test('deleting the author takes the follow with it', async () => {
  const user = await accounts.findOrCreateUser(db, 'cascade@example.com');
  const ghost = await personCalled('ghost-writer', 'Ghost Writer');

  await accounts.followAuthor(db, user.id, ghost);
  assert.equal(await accounts.isFollowingAuthor(db, user.id, ghost), true);

  // The reason the table keys on author_id with a foreign key rather than on a
  // slug: nothing is left pointing at a page that would 404.
  await db.execute({ sql: 'delete from authors where id = ?', args: [ghost] });

  assert.equal(await accounts.isFollowingAuthor(db, user.id, ghost), false);
  assert.equal((await accounts.followedAuthors(db, user.id)).length, 0);
});
