import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, newId, nowIso } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as a from '../src/accounts.js';
import * as q from '../src/queries.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-accounts-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('an address is one account however it is typed', async () => {
  const first = await a.findOrCreateUser(db, 'Reader@Example.com ');
  const second = await a.findOrCreateUser(db, 'reader@example.com');

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.id, second.id);
  assert.equal(second.email, 'reader@example.com');
});

test('a sign-in link works exactly once', async () => {
  const hash = 'hash-single-use';
  await a.insertLoginToken(db, {
    tokenHash: hash,
    email: 'once@example.com',
    expiresAt: nowIso(60_000),
  });

  assert.equal(await a.consumeLoginToken(db, hash), 'once@example.com');
  // The second click gets nothing — the update, not the application, is what
  // decides the race.
  assert.equal(await a.consumeLoginToken(db, hash), null);
});

test('an expired sign-in link is refused', async () => {
  const hash = 'hash-expired';
  await a.insertLoginToken(db, {
    tokenHash: hash,
    email: 'stale@example.com',
    expiresAt: nowIso(-60_000),
  });

  assert.equal(await a.consumeLoginToken(db, hash), null);
});

test('links are counted for the throttle', async () => {
  for (let i = 0; i < 3; i += 1) {
    await a.insertLoginToken(db, {
      tokenHash: `hash-throttle-${i}`,
      email: 'busy@example.com',
      expiresAt: nowIso(60_000),
    });
  }

  assert.equal(await a.recentLoginTokenCount(db, 'BUSY@example.com'), 3);
});

test('a session resolves to its account until it expires', async () => {
  const user = await a.findOrCreateUser(db, 'session@example.com');

  await a.insertSession(db, {
    tokenHash: 'session-live',
    userId: user.id,
    expiresAt: nowIso(60_000),
  });
  await a.insertSession(db, {
    tokenHash: 'session-dead',
    userId: user.id,
    expiresAt: nowIso(-60_000),
  });

  const live = await a.userBySession(db, 'session-live');
  assert.equal(String(live.email), 'session@example.com');

  assert.equal(await a.userBySession(db, 'session-dead'), null);
  assert.equal(await a.userBySession(db, 'session-never-existed'), null);
});

test('signing out drops only the session presented', async () => {
  const user = await a.findOrCreateUser(db, 'twodevices@example.com');

  await a.insertSession(db, { tokenHash: 'laptop', userId: user.id, expiresAt: nowIso(60_000) });
  await a.insertSession(db, { tokenHash: 'phone', userId: user.id, expiresAt: nowIso(60_000) });

  await a.deleteSession(db, 'laptop');

  assert.equal(await a.userBySession(db, 'laptop'), null);
  assert.ok(await a.userBySession(db, 'phone'), 'the other device stays signed in');
});

test('a challenge can only be taken once, and only for its purpose', async () => {
  await a.insertChallenge(db, {
    id: 'chal-1',
    challenge: 'abc',
    userId: null,
    purpose: 'login',
    expiresAt: nowIso(60_000),
  });

  assert.equal(await a.takeChallenge(db, 'chal-1', 'register'), null, 'wrong purpose is refused');

  const taken = await a.takeChallenge(db, 'chal-1', 'login');
  assert.equal(String(taken.challenge), 'abc');

  // Gone, so it cannot be replayed against a second assertion.
  assert.equal(await a.takeChallenge(db, 'chal-1', 'login'), null);
});

test('following is idempotent and reversible', async () => {
  const user = await a.findOrCreateUser(db, 'follower@example.com');
  const feed = await q.insertFeed(db, {
    slug: 'followed-blog',
    feed_url: 'https://followed.example/feed.xml',
    title: 'Followed Blog',
  });

  await a.follow(db, user.id, feed.id);
  await a.follow(db, user.id, feed.id);

  assert.equal(await a.isFollowing(db, user.id, feed.id), true);
  assert.equal((await a.followedFeeds(db, user.id)).length, 1);

  await a.unfollow(db, user.id, feed.id);
  assert.equal(await a.isFollowing(db, user.id, feed.id), false);
});

test('a credential round-trips and its counter moves forward', async () => {
  const user = await a.findOrCreateUser(db, 'passkey@example.com');

  await a.insertCredential(db, {
    id: 'credential-abc',
    user_id: user.id,
    public_key: 'cHVibGlj',
    counter: 0,
    transports: ['internal', 'hybrid'],
    device_type: 'multiDevice',
    backed_up: true,
    name: 'Synced passkey',
  });

  const stored = await a.credentialById(db, 'credential-abc');
  assert.equal(String(stored.user_id), user.id);
  assert.deepEqual(JSON.parse(String(stored.transports)), ['internal', 'hybrid']);
  assert.equal(Number(stored.backed_up), 1);

  await a.touchCredential(db, 'credential-abc', 7);
  assert.equal(Number((await a.credentialById(db, 'credential-abc')).counter), 7);
});

test('a credential can only be revoked by its owner', async () => {
  const owner = await a.findOrCreateUser(db, 'owner@example.com');
  const stranger = await a.findOrCreateUser(db, 'stranger@example.com');

  await a.insertCredential(db, {
    id: 'credential-owned',
    user_id: owner.id,
    public_key: 'cHVibGlj',
  });

  assert.equal(await a.deleteCredential(db, 'credential-owned', stranger.id), false);
  assert.equal(await a.deleteCredential(db, 'credential-owned', owner.id), true);
});

test('purging clears what has aged out and leaves what has not', async () => {
  const user = await a.findOrCreateUser(db, 'purge@example.com');

  await a.insertSession(db, { tokenHash: 'purge-old', userId: user.id, expiresAt: nowIso(-60_000) });
  await a.insertSession(db, { tokenHash: 'purge-new', userId: user.id, expiresAt: nowIso(60_000) });
  await a.insertChallenge(db, {
    id: `chal-${newId()}`,
    challenge: 'x',
    purpose: 'login',
    expiresAt: nowIso(-60_000),
  });

  const removed = await a.purgeExpired(db);
  assert.ok(removed >= 2, `expected at least the two expired rows, got ${removed}`);
  assert.ok(await a.userBySession(db, 'purge-new'), 'a live session survives the purge');
});
