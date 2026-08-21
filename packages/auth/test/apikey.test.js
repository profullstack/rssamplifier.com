import test from 'node:test';
import assert from 'node:assert/strict';

import { newApiKey, apiKeyFromRequest, looksLikeApiKey, hashToken } from '../index.js';

test('a minted key is prefixed, unique and hashed', () => {
  const a = newApiKey();
  const b = newApiKey();

  assert.match(a.token, /^rsa_[0-9a-f]{8}_/);
  assert.notEqual(a.token, b.token);
  assert.equal(a.hash, hashToken(a.token));
  assert.notEqual(a.hash, a.token, 'the stored form must not be the token');
});

test('the prefix is the public part of the token', () => {
  const key = newApiKey();
  assert.ok(key.token.startsWith(`${key.prefix}_`));

  // The secret is everything after the prefix, taken by length rather than by
  // splitting on '_'. The secret is base64url and `_` is in that alphabet, so
  // `token.split('_')[2]` is not the secret — it is the secret up to its first
  // underscore, which is a different string about one time in sixty and the
  // empty string when the secret happens to *begin* with one.
  //
  // Both of those made this test fail at random rather than on a defect:
  // `'anything'.includes('')` is true, so an empty fragment failed the
  // assertion outright, and a one- or two-character fragment could appear in
  // the eight hex characters of the prefix by coincidence. Measured over
  // 200,000 keys, the old form failed 1.77% of the time — often enough to
  // redden a branch nobody had touched, which is how a flaky test spends its
  // credibility and everyone else's time.
  const secret = key.token.slice(key.prefix.length + 1);

  assert.ok(secret.length > 0, 'there is a secret at all');
  assert.ok(!key.prefix.includes(secret), 'the secret must not be in the prefix');
});

test('a minted key is recognised as one', () => {
  assert.equal(looksLikeApiKey(newApiKey().token), true);
});

test('anything else is not', () => {
  for (const bad of ['', 'rsa_', 'rsa_zzzz_abc', 'bearer x', null, undefined, 'rsa_1234_short']) {
    assert.equal(looksLikeApiKey(bad), false, `${JSON.stringify(bad)} must not pass`);
  }
});

/**
 * @param {Record<string, string>} headers
 */
function request(headers) {
  return new Request('https://rssamplifier.com/api/feeds', { headers });
}

test('a key is read from an Authorization bearer header', () => {
  assert.equal(apiKeyFromRequest(request({ authorization: 'Bearer rsa_test' })), 'rsa_test');
});

test('the bearer scheme is matched case-insensitively', () => {
  assert.equal(apiKeyFromRequest(request({ authorization: 'bearer rsa_test' })), 'rsa_test');
});

test('a key is read from X-API-Key when Authorization is spoken for', () => {
  assert.equal(apiKeyFromRequest(request({ 'x-api-key': ' rsa_test ' })), 'rsa_test');
});

test('a request with no key presents none', () => {
  assert.equal(apiKeyFromRequest(request({})), null);
});

test('a key is never read from the query string', () => {
  // URLs reach access logs, browser history and referrer headers. A credential
  // that can be sent that way will be, and then it leaks by being written down.
  const req = new Request('https://rssamplifier.com/api/feeds?api_key=rsa_leaky');
  assert.equal(apiKeyFromRequest(req), null);
});
