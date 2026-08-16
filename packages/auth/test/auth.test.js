import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, accounts, nowIso } from '@rssamplifier/db';

import { newToken, hashToken, safeEqual } from '../src/tokens.js';
import { startSession, resolveSession, endSession, sessionCookieOptions } from '../src/session.js';
import { looksLikeEmail, consumeSignInLink, requestSignInLink } from '../src/magic.js';
import { relyingPartyId, expectedOrigins } from '../src/passkey.js';

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-auth-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('tokens are unique and never stored in the clear', () => {
  const a = newToken();
  const b = newToken();

  assert.notEqual(a, b);
  // The stored form must not be the thing the browser sends back.
  assert.notEqual(hashToken(a), a);
  assert.equal(hashToken(a), hashToken(a), 'hashing is deterministic');
  assert.notEqual(hashToken(a), hashToken(b));
});

test('safeEqual compares without throwing on mismatched lengths', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'longer'), false);
});

test('a session round-trips and can be ended', async () => {
  const user = await accounts.findOrCreateUser(db, 'round@example.com');

  const { token } = await startSession(db, user.id, { userAgent: 'test', ipHash: null });
  const resolved = await resolveSession(db, token);
  assert.equal(String(resolved.email), 'round@example.com');

  // Signing in stamps the account, which is the only thing last_login_at is for.
  assert.ok((await accounts.userById(db, user.id)).last_login_at);

  await endSession(db, token);
  assert.equal(await resolveSession(db, token), null);
});

test('an absent or unknown cookie resolves to nobody rather than throwing', async () => {
  assert.equal(await resolveSession(db, undefined), null);
  assert.equal(await resolveSession(db, ''), null);
  assert.equal(await resolveSession(db, 'not-a-real-token'), null);
});

test('the session cookie is lax and follows the scheme', () => {
  const https = sessionCookieOptions('https://rssamplifier.com');
  assert.equal(https.secure, true);
  assert.equal(https.httpOnly, true);
  // Lax, because the sign-in link arrives from a mail client and Strict would
  // withhold the cookie on exactly that navigation.
  assert.equal(https.sameSite, 'lax');

  // A Secure cookie is dropped over plain http, which would make local sign-in
  // silently do nothing.
  assert.equal(sessionCookieOptions('http://localhost:3000').secure, false);
});

test('looksLikeEmail rejects blanks and obvious rubbish', () => {
  assert.equal(looksLikeEmail('reader@example.com'), true);
  assert.equal(looksLikeEmail(''), false);
  assert.equal(looksLikeEmail('   '), false);
  assert.equal(looksLikeEmail('no-at-sign'), false);
  assert.equal(looksLikeEmail('two@@example.com'), false);
  assert.equal(looksLikeEmail(`${'a'.repeat(250)}@example.com`), false);
});

test('a sign-in link creates the account on first use', async () => {
  const token = newToken();
  await accounts.insertLoginToken(db, {
    tokenHash: hashToken(token),
    email: 'brand-new@example.com',
    expiresAt: nowIso(60_000),
  });

  const result = await consumeSignInLink(db, token);
  assert.equal(result.ok, true);
  assert.equal(result.created, true, 'signing in for the first time is the registration');
  assert.equal(result.email, 'brand-new@example.com');
});

test('a spent or missing link fails the same way', async () => {
  const token = newToken();
  await accounts.insertLoginToken(db, {
    tokenHash: hashToken(token),
    email: 'spent@example.com',
    expiresAt: nowIso(60_000),
  });

  assert.equal((await consumeSignInLink(db, token)).ok, true);

  const second = await consumeSignInLink(db, token);
  assert.equal(second.ok, false);
  // Expired, already used and never-existed are one message on purpose.
  assert.equal(second.error, 'invalid-or-expired');
  assert.equal((await consumeSignInLink(db, newToken())).error, 'invalid-or-expired');
  assert.equal((await consumeSignInLink(db, '')).error, 'missing-token');
});

test('requesting a link says so when email is not configured', async () => {
  const previous = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;

  try {
    const result = await requestSignInLink(db, 'nobody@example.com', 'https://rssamplifier.com');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'email-not-configured');
  } finally {
    if (previous !== undefined) process.env.RESEND_API_KEY = previous;
  }
});

test('the relying party is a bare domain, never a URL', () => {
  assert.equal(relyingPartyId('https://rssamplifier.com'), 'rssamplifier.com');
  assert.equal(relyingPartyId('https://rssamplifier.com/'), 'rssamplifier.com');
  assert.equal(relyingPartyId('http://localhost:3000'), 'localhost');
});

test('both apex and www count as expected origins', () => {
  const fromApex = expectedOrigins('https://rssamplifier.com');
  assert.ok(fromApex.includes('https://rssamplifier.com'));
  // A reader who registered a passkey on one must not be locked out on the other.
  assert.ok(fromApex.includes('https://www.rssamplifier.com'));

  const fromWww = expectedOrigins('https://www.rssamplifier.com');
  assert.ok(fromWww.includes('https://rssamplifier.com'));
});
