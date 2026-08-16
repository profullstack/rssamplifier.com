import test from 'node:test';
import assert from 'node:assert/strict';

import { assessFeed } from '../index.js';

const NOW = Date.parse('2026-08-16T00:00:00Z');

/**
 * @param {number} n
 * @param {object} [over]
 */
function items(n, over = {}) {
  return Array.from({ length: n }, (_, i) => ({
    title: `Post ${i}`,
    url: `https://blog.example/${i}`,
    publishedAt: new Date(NOW - i * 86_400_000).toISOString(),
    ...over,
  }));
}

/**
 * @param {object} feed
 * @param {string} [feedUrl]
 */
function assess(feed, feedUrl = 'https://blog.example/feed.xml') {
  return assessFeed({ feedUrl, feed, now: NOW });
}

test('an ordinary active blog passes', () => {
  const verdict = assess({ title: 'A Husky Blog', description: 'Dogs', items: items(12) });

  assert.equal(verdict.worthy, true);
  assert.ok(verdict.score >= 50, `score ${verdict.score}`);
});

test('a comment feed is refused whatever it contains', () => {
  const verdict = assess(
    { title: 'Comments on: things', items: items(30) },
    'https://blog.example/comments/feed/',
  );

  assert.equal(verdict.worthy, false);
  assert.deepEqual(verdict.reasons, ['comments-feed']);
});

test('a tag feed is refused — the site itself will be found separately', () => {
  const verdict = assess({ title: 'Tagged husky', items: items(30) }, 'https://b.example/tag/husky/feed');

  assert.equal(verdict.worthy, false);
  assert.deepEqual(verdict.reasons, ['partial-feed']);
});

test('a feed with one entry is a stub', () => {
  const verdict = assess({ title: 'Hello', items: items(1) });

  assert.equal(verdict.worthy, false);
  assert.deepEqual(verdict.reasons, ['too-few-items']);
});

test('a blog that stopped two years ago is abandoned', () => {
  const old = new Date(NOW - 800 * 86_400_000).toISOString();
  const verdict = assess({ title: 'Old', items: items(10, { publishedAt: old }) });

  assert.equal(verdict.worthy, false);
  assert.deepEqual(verdict.reasons, ['abandoned']);
});

test('a blog quiet for a year is still worth keeping', () => {
  // Small blogs go quiet and come back. Eighteen months is the line, not one.
  const year = new Date(NOW - 400 * 86_400_000).toISOString();
  const verdict = assess({ title: 'Quiet', description: 'x', items: items(10, { publishedAt: year }) });

  assert.equal(verdict.worthy, true);
});

test('every entry sharing one title is a ticker, not a blog', () => {
  const verdict = assess({
    title: 'Status',
    items: items(20).map((i) => ({ ...i, title: 'Update' })),
  });

  assert.equal(verdict.worthy, false);
  assert.ok(verdict.reasons.includes('duplicate-titles'));
});

test('an undated feed is penalised, not rejected', () => {
  const verdict = assess({
    title: 'No dates here',
    description: 'A real blog with a lazy generator',
    items: items(12, { publishedAt: undefined }),
  });

  assert.ok(verdict.reasons.includes('undated'));
  assert.equal(verdict.worthy, true);
});

test('entries that link nowhere cost points', () => {
  const linked = assess({ title: 'Linked', items: items(10) });
  const unlinked = assess({ title: 'Unlinked', items: items(10, { url: '' }) });

  assert.ok(unlinked.score < linked.score);
  assert.ok(unlinked.reasons.includes('unlinked-items'));
});

test('thresholds are tunable per call', () => {
  const feed = { title: 'Two posts', items: items(2) };

  assert.equal(assessFeed({ feedUrl: 'https://b.example/f', feed, now: NOW, rules: { minItems: 5 } }).worthy, false);
  assert.equal(
    assessFeed({ feedUrl: 'https://b.example/f', feed, now: NOW, rules: { minScore: 0 } }).worthy,
    true,
  );
});

test('a missing items array does not throw', () => {
  const verdict = assess({ title: 'Broken' });
  assert.equal(verdict.worthy, false);
  assert.deepEqual(verdict.reasons, ['too-few-items']);
});
