/**
 * The label a topic wears is the spelling most feeds actually use.
 *
 * Regression test for the `min(keyword)` rollup: a lexicographic minimum let
 * one publisher's malformed `<category>` tag rename a topic carried by
 * thousands of blogs, because `!`, `"`, `/`, `[` and `_` all sort before
 * lowercase letters in ASCII.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as q from '../src/queries.js';

/** Add `n` feeds that all spell the same slug the same way. */
async function feedsSpelling(db, slug, keyword, n, tag) {
  for (let i = 0; i < n; i += 1) {
    const feed = await q.insertFeed(db, {
      slug: `${tag}-${i}`,
      feed_url: `https://${tag}${i}.example/feed.xml`,
      title: `${tag} ${i}`,
      kind: 'blog',
    });
    await q.replaceFeedKeywords(db, feed.id, [
      { slug, keyword, words: 1, count: 3, source: 'category' },
    ]);
  }
}

test('a punctuation-prefixed spelling from one feed cannot rename a topic', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rssamp-topiclabel-'));
  const db = connect({ url: `file:${join(dir, 'label.db')}` });
  await migrate(db);

  // The real prod shape, scaled down: many feeds say "news", exactly one says
  // "! news", and both slug to `news`.
  await feedsSpelling(db, 'news', 'news', 5, 'plain');
  await feedsSpelling(db, 'news', '! news', 1, 'punct');

  await q.refreshTopics(db);

  const topic = await q.topicBySlug(db, 'news');
  assert.equal(topic.keyword, 'news', 'the majority spelling wins the label');
  assert.equal(topic.feedCount, 6, 'every spelling still counts toward the topic');

  await rm(dir, { recursive: true, force: true });
});

test('trailing punctuation loses to the bare word on a tie-break', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rssamp-topictie-'));
  const db = connect({ url: `file:${join(dir, 'tie.db')}` });
  await migrate(db);

  // Equal feed counts, so the count cannot decide: shortest must.
  await feedsSpelling(db, 'ai', 'ai:', 2, 'colon');
  await feedsSpelling(db, 'ai', 'ai', 2, 'bare');

  await q.refreshTopics(db);
  assert.equal((await q.topicBySlug(db, 'ai')).keyword, 'ai');

  await rm(dir, { recursive: true, force: true });
});
