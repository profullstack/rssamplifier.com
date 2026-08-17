import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RIVER_LIMIT,
  followingFeedUrl,
  mergeRiver,
  topicLabel,
} from '../src/lib/following.js';

/**
 * @param {string} title
 * @param {string} publishedAt
 * @param {object} [extra]
 */
function item(title, publishedAt, extra = {}) {
  return { guid: title, title, published_at: publishedAt, ...extra };
}

const VIA_TOPIC = { kind: 'topic', title: 'ai', href: '/topics/ai' };
const VIA_FEED = { kind: 'feed', title: '', href: '' };

test('the river is newest first across every source', () => {
  const merged = mergeRiver([
    { via: VIA_FEED, rows: [item('older', '2026-01-01T00:00:00Z')] },
    { via: VIA_TOPIC, rows: [item('newer', '2026-06-01T00:00:00Z')] },
  ]);

  assert.deepEqual(
    merged.map((row) => row.title),
    ['newer', 'older'],
  );
});

test('undated posts sort last rather than first', () => {
  // Date.parse of a missing date is NaN, and a naive comparator puts NaN
  // wherever the sort happens to leave it — which on some inputs is the top of
  // the page.
  const merged = mergeRiver([
    { via: VIA_FEED, rows: [item('undated', ''), item('dated', '2026-01-01T00:00:00Z')] },
  ]);

  assert.deepEqual(
    merged.map((row) => row.title),
    ['dated', 'undated'],
  );
});

test('one story reached by two follows appears once, and counts the rest', () => {
  const merged = mergeRiver([
    {
      via: VIA_TOPIC,
      rows: [item('same story', '2026-06-01T00:00:00Z', { cluster_key: 'abc' })],
    },
    {
      via: VIA_FEED,
      rows: [item('same story elsewhere', '2026-05-01T00:00:00Z', { cluster_key: 'abc' })],
    },
  ]);

  assert.equal(merged.length, 1);
  // Newest telling survives, so the attribution kept is the one that got there
  // first after sorting.
  assert.equal(merged[0].title, 'same story');
  assert.equal(merged[0].via.kind, 'topic');
  assert.equal(merged[0].duplicates, 1);
});

test('every row says which follow pulled it in', () => {
  const merged = mergeRiver([{ via: VIA_TOPIC, rows: [item('post', '2026-06-01T00:00:00Z')] }]);
  assert.deepEqual(merged[0].via, VIA_TOPIC);
});

test('the river is capped', () => {
  const rows = Array.from({ length: 200 }, (_, i) =>
    item(`post-${i}`, `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`),
  );

  assert.equal(mergeRiver([{ via: VIA_FEED, rows }]).length, RIVER_LIMIT);
  assert.equal(mergeRiver([{ via: VIA_FEED, rows }], 5).length, 5);
});

test('an empty set of follows is an empty river, not a crash', () => {
  assert.deepEqual(mergeRiver([]), []);
  assert.deepEqual(mergeRiver([{ via: VIA_FEED, rows: [] }]), []);
});

test('a whole topic and one category of it are labelled and linked apart', () => {
  const whole = topicLabel({ slug: 'ai', segment: '', keyword: 'ai' });
  assert.equal(whole.href, '/topics/ai');
  assert.equal(whole.title, 'ai');

  const podcasts = topicLabel({ slug: 'ai', segment: 'podcasts', keyword: 'ai' });
  assert.equal(podcasts.href, '/topics/ai/podcasts');
  assert.equal(podcasts.title, 'ai: podcasts');
});

test('a follow on a sub-group nobody recognises still points at the topic', () => {
  // A segment renamed since the follow was made. The label must not be broken
  // and the link must not 404.
  const label = topicLabel({ slug: 'ai', segment: 'elephants', keyword: 'ai' });
  assert.equal(label.href, '/topics/ai');
  assert.equal(label.segment, '');
});

test('a topic with no stored spelling falls back to its slug', () => {
  assert.equal(topicLabel({ slug: 'home-lab', segment: '' }).title, 'home-lab');
});

test('the feed URL carries the token in the query, where a rewrite cannot lose it', () => {
  const url = followingFeedUrl('https://rssamplifier.com', 'tok+en/1', 'atom');
  assert.equal(url, 'https://rssamplifier.com/following.atom?t=tok%2Ben%2F1');
});
