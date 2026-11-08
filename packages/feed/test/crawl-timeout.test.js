import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CRAWL_FETCH_TIMEOUT_MS, fetchErrorCode, hostVerdict } from '../src/fetch.js';

test('a plain crawl fetch gets ten seconds, total', () => {
  assert.equal(CRAWL_FETCH_TIMEOUT_MS, 10_000);
});

test('thrown fetch errors reduce to codes the crawler can act on', () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const cause = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

  assert.equal(fetchErrorCode(abort), 'timeout');
  assert.equal(fetchErrorCode(Object.assign(new Error('t'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(fetchErrorCode(cause('UND_ERR_CONNECT_TIMEOUT')), 'timeout');
  assert.equal(fetchErrorCode(cause('ENOTFOUND')), 'dns-failed');
  assert.equal(fetchErrorCode(cause('EAI_AGAIN')), 'dns-retry');
  assert.equal(fetchErrorCode(cause('CERT_HAS_EXPIRED')), 'tls-failed');
  assert.equal(fetchErrorCode(cause('DEPTH_ZERO_SELF_SIGNED_CERT')), 'tls-failed');
  assert.equal(fetchErrorCode(cause('ECONNREFUSED')), 'connection-failed');
  assert.equal(fetchErrorCode(cause('ECONNRESET')), 'connection-failed');
  // Bun's own spellings, on the error itself.
  assert.equal(fetchErrorCode(Object.assign(new Error('x'), { code: 'ConnectionRefused' })), 'connection-failed');
  assert.equal(fetchErrorCode(Object.assign(new Error('x'), { code: 'FailedToOpenSocket' })), 'connection-failed');
  assert.equal(fetchErrorCode(new Error('something else')), 'fetch-failed');
});

test('the host check refuses private names without asking DNS', async () => {
  assert.equal(await hostVerdict('localhost'), 'blocked');
  assert.equal(await hostVerdict('10.0.0.1'), 'blocked');
  assert.equal(await hostVerdict('93.184.216.34'), 'ok');
});

test('the host check spends the fetch budget, not its own', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(await hostVerdict('example.com', controller.signal), 'timeout');
});
