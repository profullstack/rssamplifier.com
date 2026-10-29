import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { accounts, coinpay } from '@rssamplifier/db';
import { connectTest } from '@rssamplifier/db/src/testdb.js';

import {
  canRemovePasskey,
  disconnectCoinpay,
  safeNext,
  savePending,
  signInWithCoinpay,
  takeCallback,
} from '../src/coinpay.js';
import { consumeSignInLink } from '../src/magic.js';
import { hashToken, newToken } from '../src/tokens.js';

/**
 * Sign in with CoinPay. The STANDING rule these hold: an account is bound to
 * the CoinPay sub, a matching CoinPay email never takes over an account,
 * linking needs the session that asked, and a bad or replayed state is refused.
 */

let db;
let seq = 0;
const sub = () => `cp-sub-${++seq}-${newToken().slice(0, 6)}`;

before(async () => {
  db = await connectTest({ prefix: 'rssamp_coinpay' });
});

after(() => {
  db.close();
});

test('a CoinPay email matching an existing account gets its own new account', async () => {
  const victim = await accounts.findOrCreateUser(db, 'victim@example.com');

  const result = await signInWithCoinpay(
    db,
    { sub: sub(), email: 'Victim@Example.com', name: 'Mallory' },
    { linkUserId: null },
  );

  assert.equal(result.ok, true);
  assert.notEqual(result.userId, victim.id);
  assert.equal(result.created, true);
  const made = await accounts.userById(db, result.userId);
  assert.ok(coinpay.isPlaceholderEmail(made.email), 'the CoinPay email is not the account address');
  assert.equal((await accounts.userByEmail(db, 'victim@example.com')).id, victim.id);
});

test('the same sub signs back into the same account', async () => {
  const id = sub();
  const first = await signInWithCoinpay(db, { sub: id, email: null, name: null }, { linkUserId: null });
  const again = await signInWithCoinpay(db, { sub: id, email: 'new@example.com', name: null }, { linkUserId: null });
  assert.equal(again.ok, true);
  assert.equal(again.userId, first.userId);
  assert.equal(again.created, false);
});

test('connect binds to the signed-in account, and a sub belongs to one account', async () => {
  const alice = await accounts.findOrCreateUser(db, 'alice@example.com');
  const bob = await accounts.findOrCreateUser(db, 'bob@example.com');
  const id = sub();

  const linked = await signInWithCoinpay(db, { sub: id, email: null, name: null }, { linkUserId: alice.id });
  assert.deepEqual(linked, { ok: true, userId: alice.id, created: false, linked: true });

  assert.deepEqual(
    await signInWithCoinpay(db, { sub: id, email: null, name: null }, { linkUserId: bob.id }),
    { ok: false, error: 'linked-elsewhere' },
  );
  assert.deepEqual(
    await signInWithCoinpay(db, { sub: sub(), email: null, name: null }, { linkUserId: alice.id }),
    { ok: false, error: 'already-linked' },
  );

  const login = await signInWithCoinpay(db, { sub: id, email: null, name: null }, { linkUserId: null });
  assert.equal(login.userId, alice.id);
});

test('a callback needs the state this browser started, once', async () => {
  const state = newToken();
  await savePending(db, state, { verifier: 'v', nonce: 'n', next: '/following', linkUserId: null });

  assert.deepEqual(await takeCallback(db, { state, cookieState: 'other', sessionUserId: null }), {
    ok: false,
    error: 'bad-state',
  });
  assert.deepEqual(await takeCallback(db, { state, cookieState: undefined, sessionUserId: null }), {
    ok: false,
    error: 'bad-state',
  });
  assert.deepEqual(await takeCallback(db, { state: 'forged', cookieState: 'forged', sessionUserId: null }), {
    ok: false,
    error: 'expired',
  });

  const ok = await takeCallback(db, { state, cookieState: state, sessionUserId: null });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.pending, { verifier: 'v', nonce: 'n', next: '/following', linkUserId: null });

  assert.deepEqual(await takeCallback(db, { state, cookieState: state, sessionUserId: null }), {
    ok: false,
    error: 'expired',
  });
});

test('connect must be finished by the session that started it', async () => {
  const carol = await accounts.findOrCreateUser(db, 'carol@example.com');
  const state = newToken();
  await savePending(db, state, { verifier: 'v', nonce: 'n', next: '/account', linkUserId: carol.id });

  assert.deepEqual(await takeCallback(db, { state, cookieState: state, sessionUserId: null }), {
    ok: false,
    error: 'wrong-session',
  });

  const again = newToken();
  await savePending(db, again, { verifier: 'v', nonce: 'n', next: '/account', linkUserId: carol.id });
  const ok = await takeCallback(db, { state: again, cookieState: again, sessionUserId: carol.id });
  assert.equal(ok.ok, true);
});

test('only same-origin paths survive as next', () => {
  assert.equal(safeNext('/following'), '/following');
  assert.equal(safeNext('//evil.example'), '/account');
  assert.equal(safeNext('/\\evil.example'), '/account');
  assert.equal(safeNext('https://evil.example'), '/account');
  assert.equal(safeNext(undefined), '/account');
});

test('CoinPay cannot be disconnected when it is the only way in', async () => {
  const only = await signInWithCoinpay(db, { sub: sub(), email: null, name: null }, { linkUserId: null });
  assert.deepEqual(await disconnectCoinpay(db, only.userId), { ok: false, error: 'only-sign-in' });

  const dana = await accounts.findOrCreateUser(db, 'dana@example.com');
  await signInWithCoinpay(db, { sub: sub(), email: null, name: null }, { linkUserId: dana.id });
  assert.deepEqual(await disconnectCoinpay(db, dana.id), { ok: true });
  assert.deepEqual(await disconnectCoinpay(db, dana.id), { ok: false, error: 'not-linked' });

  // A placeholder account's last passkey is kept once CoinPay is gone.
  assert.equal(await canRemovePasskey(db, only.userId), true, 'CoinPay still connected');
  assert.equal(await canRemovePasskey(db, dana.id), true, 'a proven address is a way in');
});

test('a claim link gives a placeholder account the address, and never a taken one', async () => {
  const cp = await signInWithCoinpay(db, { sub: sub(), email: null, name: null }, { linkUserId: null });

  const token = newToken();
  await accounts.insertLoginToken(db, {
    tokenHash: hashToken(token),
    email: 'mine@example.com',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    claimUserId: cp.userId,
  });
  const spent = await consumeSignInLink(db, token);
  assert.deepEqual(spent, { ok: true, userId: cp.userId, email: 'mine@example.com', created: false });
  assert.equal((await accounts.userById(db, cp.userId)).email, 'mine@example.com');

  // Now the address is taken: a second placeholder account cannot claim it.
  const other = await signInWithCoinpay(db, { sub: sub(), email: null, name: null }, { linkUserId: null });
  const second = newToken();
  await accounts.insertLoginToken(db, {
    tokenHash: hashToken(second),
    email: 'mine@example.com',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    claimUserId: other.userId,
  });
  assert.deepEqual(await consumeSignInLink(db, second), { ok: false, error: 'claim-failed' });
  assert.ok(coinpay.isPlaceholderEmail((await accounts.userById(db, other.userId)).email));
});
