import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pageParam } from '../src/lib/pageParam.js';

test('a percent-encoded segment comes back as the stored slug', () => {
  assert.equal(pageParam('%E6%83%85%E5%A0%B1%E3%81%AE%E7%81%AF%E5%8F%B0'), '情報の灯台');
  assert.equal(pageParam('s%C3%A6tlisten'), 'sætlisten');
});

test('an already-decoded or plain slug is untouched', () => {
  assert.equal(pageParam('情報の灯台'), '情報の灯台');
  assert.equal(pageParam('ascii-blog'), 'ascii-blog');
});

test('a malformed escape is left as it is rather than throwing', () => {
  assert.equal(pageParam('100%-pure'), '100%-pure');
  assert.equal(pageParam(undefined), '');
});
