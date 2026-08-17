import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as accounts from '../src/accounts.js';
import * as apikeys from '../src/apikeys.js';

let dir;
let db;
let user;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-keys-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
  user = await accounts.findOrCreateUser(db, 'keys@example.com');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * @param {string} hash
 * @param {string} [name]
 */
function insert(hash, name = 'test key') {
  return apikeys.insertKey(db, {
    userId: String(user.id),
    name,
    prefix: `rsa_${hash.slice(0, 8)}`,
    hash,
  });
}

test('a stored key is found by its hash', async () => {
  await insert('hash-one', 'my crawler');
  const found = await apikeys.keyByHash(db, 'hash-one');

  assert.ok(found);
  assert.equal(found.name, 'my crawler');
  assert.equal(Number(found.hourly_limit) > 0, true);
});

test('the hash is never handed back in a listing', async () => {
  const rows = await apikeys.keysForUser(db, String(user.id));
  for (const row of rows) {
    assert.equal('token_hash' in row, false, 'a listing must not carry the stored secret');
  }
});

test('an unknown key is not found', async () => {
  assert.equal(await apikeys.keyByHash(db, 'never-issued'), null);
});

test('a revoked key stops being found at all', async () => {
  const key = await insert('hash-two');
  assert.ok(await apikeys.keyByHash(db, 'hash-two'));

  assert.equal(await apikeys.revokeKey(db, key.id, String(user.id)), true);

  // Indistinguishable from "no such key", so a caller cannot confirm that a
  // guessed token once existed.
  assert.equal(await apikeys.keyByHash(db, 'hash-two'), null);
});

test('one account cannot revoke another account s key', async () => {
  const key = await insert('hash-three');
  const other = await accounts.findOrCreateUser(db, 'stranger@example.com');

  assert.equal(await apikeys.revokeKey(db, key.id, String(other.id)), false);
  assert.ok(await apikeys.keyByHash(db, 'hash-three'), 'the key must still work');
});

test('revoking twice reports the second attempt as a no-op', async () => {
  const key = await insert('hash-four');
  assert.equal(await apikeys.revokeKey(db, key.id, String(user.id)), true);
  assert.equal(await apikeys.revokeKey(db, key.id, String(user.id)), false);
});

test('the live count ignores revoked keys', async () => {
  const fresh = await accounts.findOrCreateUser(db, 'counter@example.com');
  const a = await apikeys.insertKey(db, {
    userId: String(fresh.id),
    name: 'a',
    prefix: 'rsa_aaaaaaaa',
    hash: 'count-a',
  });
  await apikeys.insertKey(db, {
    userId: String(fresh.id),
    name: 'b',
    prefix: 'rsa_bbbbbbbb',
    hash: 'count-b',
  });

  assert.equal(await apikeys.liveKeyCount(db, String(fresh.id)), 2);
  await apikeys.revokeKey(db, a.id, String(fresh.id));
  assert.equal(await apikeys.liveKeyCount(db, String(fresh.id)), 1);
});

test('last-used is written once and then left alone for an hour', async () => {
  const key = await insert('hash-five');

  await apikeys.touchKey(db, key.id, null);
  const first = await apikeys.keyByHash(db, 'hash-five');
  assert.ok(first.last_used_at, 'a key that has never been used records its first use');

  // A second request in the same hour must not write again: this runs on every
  // API call, and a write per request is the thing it exists to avoid.
  await apikeys.touchKey(db, key.id, first.last_used_at);
  const second = await apikeys.keyByHash(db, 'hash-five');
  assert.equal(second.last_used_at, first.last_used_at);
});

test('last-used is refreshed once the recorded time is stale', async () => {
  const key = await insert('hash-six');
  const old = new Date(Date.now() - 7_200_000).toISOString();

  await apikeys.touchKey(db, key.id, old);
  const row = await apikeys.keyByHash(db, 'hash-six');

  assert.notEqual(row.last_used_at, old);
});
