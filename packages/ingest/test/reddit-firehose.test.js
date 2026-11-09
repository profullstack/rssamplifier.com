import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { q, social } from '@rssamplifier/db';
import { connectTest } from '@rssamplifier/db/src/testdb.js';
import { redditSource } from '@rssamplifier/social';

import { createRedditFirehose } from '../src/redditFirehose.js';

let db;

beforeEach(async () => {
  db?.close();
  db = await connectTest();
});

after(async () => {
  db?.close();
});

async function seedSub(name) {
  const source = redditSource(`r/${name}`);
  const stored = await social.upsertSocialSource(db, {
    network: 'reddit',
    ref: source.ref,
    slug: source.slug,
    title: source.title,
    feedUrl: source.feedUrl,
    siteUrl: source.feedUrl,
  });
  return String(stored.id);
}

const T0 = 1_794_000_000;
const post = (id, subreddit, at) => ({
  id,
  title: `post ${id}`,
  author: 'someone',
  subreddit,
  permalink: `/r/${subreddit}/comments/${id}/x/`,
  created_utc: at,
  is_self: true,
  selftext: 'hello',
  num_comments: 0,
  removed_by_category: null,
});

test('every new post reaches the subreddit row it belongs to, and nothing else is stored', async () => {
  const rss = await seedSub('rss');
  const linux = await seedSub('linux');

  // Two pages: a full one (forces a second read) then a short one (caught up).
  const first = Array.from({ length: 100 }, (_, i) => post(`a${i}`, i % 2 ? 'RSS' : 'notours', T0 + i));
  const second = [post('b1', 'linux', T0 + 200), post('b2', 'rss', T0 + 201)];
  const asked = [];
  const fetchPage = async (after) => {
    asked.push(after);
    return asked.length === 1 ? first : asked.length === 2 ? [first[99], ...second] : [];
  };

  const run = createRedditFirehose({ fetchPage, now: () => (T0 + 300) * 1000, lookbackSeconds: 300 });
  const res = await run(db);

  assert.equal(asked.length, 2, 'stopped once a page came back short');
  assert.equal(asked[1], T0 + 98, 'the next page starts a second back so a split second is read whole');
  assert.equal(res.posts, 102, 'the overlapping post is not counted twice');
  assert.equal(res.matched, 2);

  const { rows: counted } = await db.execute({ sql: 'select guid from feed_items where feed_id = ?', args: [rss] });
  const guids = counted.map((r) => String(r.guid));
  // 51 matched (r/RSS case-insensitively); ITEMS_PER_CRAWL keeps the newest 50,
  // so only the oldest is dropped. Two-minute passes never meet that cap.
  assert.equal(guids.length, 50);
  assert.ok(guids.includes('t3_b2') && !guids.includes('t3_a1'));
  const linuxItems = await q.itemsForFeed(db, linux, 100);
  assert.deepEqual(linuxItems.map((r) => r.guid), ['t3_b1']);

  const [row] = (await db.execute({ sql: 'select last_success_at from feeds where id = ?', args: [rss] })).rows;
  assert.ok(row.last_success_at, 'the row is marked read');
});
