import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, newId } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as a from '../src/accounts.js';
import * as al from '../src/alerts.js';
import * as q from '../src/queries.js';

/**
 * The storage under alerts: the flag on a follow, and where an account's alerts
 * go. The sending itself is tested in @rssamplifier/notify, which is where it
 * lives.
 */

let dir;
let db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-alerts-db-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * @param {string} slug
 * @returns {Promise<string>}
 */
async function feed(slug) {
  const inserted = await q.insertFeed(db, {
    slug,
    feed_url: `https://${slug}.example.com/feed.xml`,
    title: slug,
  });
  return String(inserted.id);
}

test('a follow starts quiet, and alerting is a flag on it', async () => {
  const user = await a.findOrCreateUser(db, 'flag@example.com');
  const id = await feed('flagged');

  await a.follow(db, user.id, id);
  assert.deepEqual(await al.feedFollowState(db, user.id, id), { following: true, alerts: false });

  await al.setFeedAlerts(db, user.id, id, true);
  assert.deepEqual(await al.feedFollowState(db, user.id, id), { following: true, alerts: true });

  await al.setFeedAlerts(db, user.id, id, false);
  assert.deepEqual(await al.feedFollowState(db, user.id, id), { following: true, alerts: false });
});

test('alerting on something not followed is refused rather than invented', async () => {
  const user = await a.findOrCreateUser(db, 'unfollowed@example.com');
  const id = await feed('never-followed');

  assert.equal(await al.setFeedAlerts(db, user.id, id, true), false);
  assert.equal(await al.setTopicAlerts(db, user.id, 'nothing', '', true), false);
  assert.deepEqual(await al.feedFollowState(db, user.id, id), { following: false, alerts: false });
});

test('unfollowing takes the alert with it', async () => {
  const user = await a.findOrCreateUser(db, 'undo@example.com');
  const id = await feed('undone');

  await a.follow(db, user.id, id);
  await al.setFeedAlerts(db, user.id, id, true);
  await a.unfollow(db, user.id, id);

  assert.deepEqual(await al.feedFollowState(db, user.id, id), { following: false, alerts: false });

  // And following again starts quiet: the row is new, so the flag is the
  // default rather than whatever it was before.
  await a.follow(db, user.id, id);
  assert.deepEqual(await al.feedFollowState(db, user.id, id), { following: true, alerts: false });
});

test('a topic and one category of it alert separately', async () => {
  const user = await a.findOrCreateUser(db, 'segments@example.com');

  await a.followTopic(db, user.id, 'ai');
  await a.followTopic(db, user.id, 'ai', 'podcasts');
  await al.setTopicAlerts(db, user.id, 'ai', 'podcasts', true);

  assert.deepEqual(await al.topicFollowState(db, user.id, 'ai'), { following: true, alerts: false });
  assert.deepEqual(await al.topicFollowState(db, user.id, 'ai', 'podcasts'), {
    following: true,
    alerts: true,
  });

  // Case, like everywhere else a segment is read from a URL.
  assert.equal((await al.topicFollowState(db, user.id, 'ai', 'PODCASTS')).alerts, true);
});

test('re-adding a channel revives it instead of duplicating it', async () => {
  const user = await a.findOrCreateUser(db, 'revive@example.com');

  const first = await al.addChannel(db, {
    userId: user.id,
    kind: 'web',
    target: 'https://push.example.com/e1',
    secret: { p256dh: 'one', auth: 'a' },
  });

  // Retired by the sender after enough failures.
  for (let i = 0; i < al.MAX_CHANNEL_FAILURES; i += 1) {
    await al.recordChannelResult(db, first, { ok: false, error: 'push-500' });
  }
  assert.equal(Number((await al.channelsForUser(db, user.id))[0].enabled), 0);

  // The browser subscribes again — same endpoint, new keys. That is an
  // assertion that it works, so it comes back rather than staying off.
  const second = await al.addChannel(db, {
    userId: user.id,
    kind: 'web',
    target: 'https://push.example.com/e1',
    secret: { p256dh: 'two', auth: 'b' },
  });

  assert.equal(second, first, 'the same row');
  const channels = await al.channelsForUser(db, user.id);
  assert.equal(channels.length, 1);
  assert.equal(Number(channels[0].enabled), 1);
  assert.equal(Number(channels[0].failures), 0);

  const [live] = await al.deliverableChannels(db, user.id);
  assert.deepEqual(live.secret, { p256dh: 'two', auth: 'b' }, 'and the new keys are what is used');
});

test('resuming a paused channel gives it a fresh run', async () => {
  const user = await a.findOrCreateUser(db, 'resume@example.com');
  const id = await al.addChannel(db, { userId: user.id, kind: 'webhook', target: 'https://h.example.com/x' });

  await al.recordChannelResult(db, id, { ok: false, error: 'webhook-500' });
  await al.setChannelEnabled(db, id, user.id, false);
  await al.setChannelEnabled(db, id, user.id, true);

  const [channel] = await al.channelsForUser(db, user.id);
  assert.equal(Number(channel.enabled), 1);
  assert.equal(Number(channel.failures), 0, 'or the next failure would retire it immediately');
});

test('a channel id is not a capability', async () => {
  const mine = await a.findOrCreateUser(db, 'mine@example.com');
  const theirs = await a.findOrCreateUser(db, 'theirs@example.com');

  const id = await al.addChannel(db, { userId: mine.id, kind: 'webhook', target: 'https://h.example.com/private' });

  assert.equal(await al.setChannelEnabled(db, id, theirs.id, false), false);
  assert.equal(await al.deleteChannel(db, id, theirs.id), false);
  assert.equal((await al.channelsForUser(db, mine.id)).length, 1, 'still there');
});

test('a listed channel never carries its secret', async () => {
  const user = await a.findOrCreateUser(db, 'secret@example.com');
  await al.addChannel(db, {
    userId: user.id,
    kind: 'webhook',
    target: 'https://h.example.com/signed',
    secret: { secret: 'do-not-show-this' },
  });

  const [listed] = await al.channelsForUser(db, user.id);
  assert.equal(listed.secret, undefined);
  assert.equal(JSON.stringify(listed).includes('do-not-show-this'), false);

  const [deliverable] = await al.deliverableChannels(db, user.id);
  assert.equal(deliverable.secret.secret, 'do-not-show-this', 'but the sender still gets it');
});

test('a push channel can be forgotten by its endpoint', async () => {
  const user = await a.findOrCreateUser(db, 'endpoint@example.com');
  await al.addChannel(db, {
    userId: user.id,
    kind: 'web',
    target: 'https://push.example.com/rotated',
    secret: { p256dh: 'k', auth: 'a' },
  });

  assert.equal(await al.deletePushChannel(db, user.id, 'https://push.example.com/rotated'), true);
  assert.equal((await al.channelsForUser(db, user.id)).length, 0);
});

test('what alerts is listed apart from what is merely followed', async () => {
  const user = await a.findOrCreateUser(db, 'listing@example.com');
  const loud = await feed('loud');
  const quiet = await feed('quiet');

  await a.follow(db, user.id, loud);
  await a.follow(db, user.id, quiet);
  await al.setFeedAlerts(db, user.id, loud, true);

  await a.followTopic(db, user.id, 'rust');
  await a.followTopic(db, user.id, 'go');
  await al.setTopicAlerts(db, user.id, 'rust', '', true);

  const listed = await al.alertingFollows(db, user.id);
  assert.deepEqual(listed.feeds.map((f) => String(f.slug)), ['loud']);
  assert.deepEqual(listed.topics.map((t) => String(t.slug)), ['rust']);
});

test('the sent-log is a working set, not a history', async () => {
  const user = await a.findOrCreateUser(db, 'sweep@example.com');

  await al.markSent(db, user.id, ['c:recent']);
  // A row from well past the window, written directly because markSent stamps
  // the present.
  await db.execute({
    sql: 'insert into alert_sent (user_id, item_key, sent_at) values (?, ?, ?)',
    args: [user.id, 'c:ancient', '2024-01-01T00:00:00.000Z'],
  });

  assert.equal(await al.pruneAlertSent(db), 1);
  assert.deepEqual([...(await al.alreadySent(db, user.id, ['c:recent', 'c:ancient']))], ['c:recent']);
});

test('more keys than SQLite will bind at once is still one answer', async () => {
  const user = await a.findOrCreateUser(db, 'many-keys@example.com');
  // Past the 999-parameter ceiling, which a single `in (…)` list would hit and
  // throw on — taking the whole alert pass with it.
  const keys = Array.from({ length: 1200 }, (_, i) => `c:k${i}`);

  await al.markSent(db, user.id, keys.filter((_, i) => i % 2 === 0));
  const seen = await al.alreadySent(db, user.id, keys);

  assert.equal(seen.size, 600);
  assert.ok(seen.has('c:k0'));
  assert.equal(seen.has('c:k1'), false);
});

test('a story is keyed by its cluster, and otherwise by feed and guid', () => {
  assert.equal(al.itemKey({ cluster_key: 'k', feed_slug: 'a', guid: 'g' }), 'c:k');

  // Without a cluster key the guid alone is not enough: guids are unique within
  // a feed, not across the directory.
  assert.notEqual(
    al.itemKey({ feed_slug: 'a', guid: '1' }),
    al.itemKey({ feed_slug: 'b', guid: '1' }),
  );
});

test('the subscriber count agrees with the list it is a count of', async () => {
  // /crawlstats uses this to tell a sender with nobody to serve from one that
  // has died, so the two must never disagree — a count that drifted from the
  // list would put the board's one alarm on a healthy sender, or hide a dead
  // one behind a number.
  const listed = (await al.usersWithAlerts(db, 1_000)).length;
  assert.equal(await al.alertingAccountCount(db), listed);

  const user = await a.findOrCreateUser(db, `counted-${newId()}@example.com`);
  const id = await feed(`counted-${newId()}`);
  await a.follow(db, user.id, id);
  await al.setFeedAlerts(db, user.id, id, true);
  await al.addChannel(db, { userId: user.id, kind: 'email', target: 'counted@example.com' });

  assert.equal(await al.alertingAccountCount(db), listed + 1);
});

test('an account is only a candidate with both a flag and a channel', async () => {
  const user = await a.findOrCreateUser(db, `candidate-${newId()}@example.com`);
  const id = await feed(`candidate-${newId()}`);

  const has = async () => (await al.usersWithAlerts(db, 500)).some((u) => u.id === String(user.id));

  await a.follow(db, user.id, id);
  await al.setFeedAlerts(db, user.id, id, true);
  assert.equal(await has(), false, 'a flag with nowhere to send is not a candidate');

  const channel = await al.addChannel(db, { userId: user.id, kind: 'email', target: 'candidate@example.com' });
  assert.equal(await has(), true);

  await al.setChannelEnabled(db, channel, user.id, false);
  assert.equal(await has(), false, 'and neither is a channel that is switched off');
});
