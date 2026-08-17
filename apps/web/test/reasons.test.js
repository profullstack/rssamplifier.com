import assert from 'node:assert/strict';
import { test } from 'node:test';

import { explain, REASONS } from '../src/lib/reasons.js';

test('a stored reason becomes words, however it was stored', () => {
  // The checker writes a JSON array; a resolve error writes a bare code. Both
  // reach the same page and both have to read as English.
  assert.equal(explain('["too-few-items"]'), 'too few entries');
  assert.equal(explain('no-feed-found'), 'no feed on the site');
  assert.equal(
    explain('["too-few-items","abandoned"]'),
    'too few entries, nothing posted in over 18 months',
  );
});

test('an HTTP status says what the site did rather than showing a code', () => {
  assert.equal(explain('http-403'), 'site refused us (403)');
  assert.equal(explain('http-404'), 'page not found (404)');
  assert.equal(explain('http-429'), 'site rate-limited us (429)');
  assert.equal(explain('http-503'), 'site is erroring (503)');
  assert.equal(explain('http-418'), 'site answered 418');
});

test('every reason the checker actually emits has words', () => {
  // These were read out of a real run's rejections. A code with no entry falls
  // through to itself, which is how "off-topic" reached the page verbatim.
  for (const code of ['off-topic', 'blocked-redirect', 'invalid-url', 'already-indexed']) {
    assert.ok(REASONS[code], `${code} needs words`);
    assert.notEqual(explain(code), code, `${code} should not render as its own code`);
  }
});

test('an unknown reason degrades to itself rather than to nothing', () => {
  assert.equal(explain('some-new-code'), 'some-new-code');
  assert.equal(explain(''), 'unknown');
  assert.equal(explain(null), 'unknown');
  // Malformed JSON is treated as the literal string, not as a crash.
  assert.equal(explain('["unclosed'), '["unclosed');
});
