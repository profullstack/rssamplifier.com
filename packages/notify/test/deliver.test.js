import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, newId, accounts, alerts, authors, q } from '@rssamplifier/db';

import { deliverAlerts } from '../src/deliver.js';

/**
 * The sender, end to end, against a real database.
 *
 * The interesting behaviour is all in the seams — the first pass that must send
 * nothing, the watermark that must not step over an unread source, the
 * de-duplication that must survive a restart — and none of it is visible from a
 * unit test of any one function. So this drives `deliverAlerts` itself and reads
 * what came out of the other end.
 */

let dir;
let db;
let sent;

/** A transport that records instead of sending. */
function recorder(outcomes = {}) {
  return {
    emailEnabled: () => outcomes.emailEnabled !== false,
    email: async (message) => {
      sent.email.push(message);
      return outcomes.email ?? { ok: true };
    },
    push: async (subscription, payload) => {
      sent.push.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
      return outcomes.push ?? { ok: true };
    },
    webhook: async (url, payload) => {
      sent.webhook.push({ url, payload });
      return outcomes.webhook ?? { ok: true };
    },
  };
}

beforeEach(async () => {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'rssamp-alerts-'));
  // A fresh database per test: the watermark is process-wide state by design,
  // and tests that shared one would each depend on the order of the others.
  db = connect({ url: `file:${join(dir, `${newId()}.db`)}` });
  await migrate(db);
  sent = { email: [], push: [], webhook: [] };
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/**
 * A signed-in reader with somewhere for alerts to go.
 *
 * @param {string} email
 * @returns {Promise<string>} the user id
 */
async function reader(email = 'reader@example.com') {
  const user = await accounts.findOrCreateUser(db, email);
  const id = String(user.id);
  await alerts.addChannel(db, { userId: id, kind: 'email', target: email, label: 'Email' });
  return id;
}

/**
 * A feed with a fixed slug.
 *
 * @param {{ slug: string, title?: string, kind?: string }} feed
 * @returns {Promise<string>} the feed id
 */
async function feed({ slug, title = slug, kind = 'blog' }) {
  const inserted = await q.insertFeed(db, {
    slug,
    feed_url: `https://${slug}.example.com/feed.xml`,
    site_url: `https://${slug}.example.com/`,
    title,
    kind,
  });
  return String(inserted.id);
}

/**
 * A post, ingested at a time we choose.
 *
 * Written straight in rather than through `upsertItems`, which stamps
 * `created_at` with the present — and `created_at` is the clock the watermark
 * runs on, so a test that could not set it could not test the watermark.
 *
 * @param {string} feedId
 * @param {{ guid: string, title?: string, createdAt: string, clusterKey?: string }} item
 */
async function post(feedId, { guid, title = guid, createdAt, clusterKey = null }) {
  await db.execute({
    sql: `insert into feed_items
            (id, feed_id, guid, url, title, summary, published_at, categories, created_at, cluster_key)
          values (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
    args: [
      newId(),
      feedId,
      guid,
      `https://example.com/${guid}`,
      title,
      'A summary.',
      createdAt,
      createdAt,
      clusterKey,
    ],
  });
}

/**
 * File a feed under a topic, which is what makes the topic exist.
 *
 * @param {string} feedId
 * @param {string} slug
 */
async function topic(feedId, slug) {
  await db.execute({
    sql: `insert into feed_keywords (feed_id, keyword, slug, count, source)
          values (?, ?, ?, 5, 'category')`,
    args: [feedId, slug, slug],
  });
}

/**
 * Credit a feed to a person, which is what makes an author follow deliver.
 *
 * @param {string} feedId
 * @param {string} slug
 * @param {string} name
 * @returns {Promise<string>}
 */
async function credit(feedId, slug, name) {
  const { id } = await authors.upsertAuthor(db, {
    identityKey: `mailto:${slug}@example.com`,
    slug,
    name,
    normName: name.toLowerCase(),
    confidence: 0.9,
  });
  await authors.linkFeedAuthor(db, feedId, String(id), { role: 'owner', confidence: 0.9 });
  return String(id);
}

const run = (opts = {}) => deliverAlerts(db, { transport: recorder(), origin: 'https://x.test', ...opts });

test('the first pass sends nothing and starts the clock', async () => {
  const userId = await reader();
  const blog = await feed({ slug: 'old-blog' });
  await alerts.setFeedAlerts(db, userId, blog, true);
  await accounts.follow(db, userId, blog);
  await alerts.setFeedAlerts(db, userId, blog, true);

  // Two years of backlog, which is exactly what must not arrive in an inbox.
  await post(blog, { guid: 'ancient', createdAt: '2024-01-01T00:00:00.000Z' });

  const result = await run();

  assert.equal(result.items, 0, 'nothing sent on the first pass');
  assert.equal(sent.email.length, 0);
  assert.ok(await alerts.alertCursor(db, userId), 'but the watermark is set');
});

test('a post published after the watermark is alerted, once', async () => {
  const userId = await reader();
  const blog = await feed({ slug: 'live-blog', title: 'Live Blog' });
  await accounts.follow(db, userId, blog);
  await alerts.setFeedAlerts(db, userId, blog, true);

  await run(); // sets the watermark

  await post(blog, { guid: 'fresh', title: 'A fresh post', createdAt: future(1) });

  const first = await run();
  assert.equal(first.items, 1);
  assert.equal(sent.email.length, 1);
  assert.match(sent.email[0].subject, /A fresh post — Live Blog/);
  // Our page for the post, not the publisher's — see renderEmail.
  assert.match(sent.email[0].text, /https:\/\/x\.test\/live-blog\/read\?p=fresh/);

  // The same pass again. Nothing new has been published, and nothing may be
  // sent — this is the case a moved watermark alone would get right and a
  // restart mid-batch would not.
  const second = await run();
  assert.equal(second.items, 0);
  assert.equal(sent.email.length, 1);
});

test('a followed blog with the bell off stays quiet', async () => {
  const userId = await reader();
  const blog = await feed({ slug: 'quiet-blog' });
  await accounts.follow(db, userId, blog);

  // Following without alerting. The account still has a channel, so it is only
  // the flag keeping this quiet.
  const loud = await feed({ slug: 'loud-blog' });
  await accounts.follow(db, userId, loud);
  await alerts.setFeedAlerts(db, userId, loud, true);

  await run();
  await post(blog, { guid: 'unheard', createdAt: future(1) });
  await post(loud, { guid: 'heard', createdAt: future(2) });

  const result = await run();

  assert.equal(result.items, 1);
  assert.doesNotMatch(sent.email[0].text, /unheard/);
  assert.match(sent.email[0].text, /heard/);
});

test('alerting on a topic catches a blog that is not followed', async () => {
  const userId = await reader();
  const stranger = await feed({ slug: 'stranger', title: 'A Stranger' });
  await topic(stranger, 'gardening');

  await accounts.followTopic(db, userId, 'gardening');
  await alerts.setTopicAlerts(db, userId, 'gardening', '', true);

  await run();
  await post(stranger, { guid: 'tomatoes', title: 'On tomatoes', createdAt: future(1) });

  const result = await run();

  assert.equal(result.items, 1);
  assert.match(sent.email[0].text, /On tomatoes/);
  // The follow that pulled it in is named, so the reader is not left working
  // out which of their follows produced a blog they have never heard of.
  assert.match(sent.email[0].text, /via gardening/);
});

test('alerting on a person catches every publication they write for', async () => {
  const userId = await reader();
  // Two publications, neither of them followed. The follow is on the human.
  const blog = await feed({ slug: 'her-blog', title: 'Her Blog' });
  const guest = await feed({ slug: 'someone-elses', title: "Someone Else's Newsletter" });
  const ada = await credit(blog, 'ada-lovelace', 'Ada Lovelace');
  await authors.linkFeedAuthor(db, guest, ada, { role: 'author', confidence: 0.9 });

  await accounts.followAuthor(db, userId, ada);
  await alerts.setAuthorAlerts(db, userId, ada, true);

  await run();
  await post(blog, { guid: 'at-home', title: 'Written at home', createdAt: future(1) });
  await post(guest, { guid: 'away', title: 'Written as a guest', createdAt: future(2) });

  const result = await run();

  // The whole point of following a person: the guest post arrives even though
  // nothing about that newsletter was ever followed.
  assert.equal(result.items, 2);
  assert.match(sent.email[0].text, /Written at home/);
  assert.match(sent.email[0].text, /Written as a guest/);
  // Attributed to her rather than to a publication the reader does not know.
  assert.match(sent.email[0].text, /via Ada Lovelace/);
});

test('an author follow with the bell off stays quiet', async () => {
  const userId = await reader();
  const blog = await feed({ slug: 'quiet-blog' });
  const grace = await credit(blog, 'grace-hopper', 'Grace Hopper');

  // Followed, deliberately not alerting. Collecting is not being interrupted.
  await accounts.followAuthor(db, userId, grace);

  await run();
  await post(blog, { guid: 'unheard', title: 'Not worth waking you', createdAt: future(1) });

  assert.equal((await run()).items, 0);
});

test('a topic follow narrowed to a category ignores the others', async () => {
  const userId = await reader();
  const blog = await feed({ slug: 'ai-blog', kind: 'blog' });
  const show = await feed({ slug: 'ai-show', kind: 'podcast' });
  await topic(blog, 'ai');
  await topic(show, 'ai');

  await accounts.followTopic(db, userId, 'ai', 'podcasts');
  await alerts.setTopicAlerts(db, userId, 'ai', 'podcasts', true);

  await run();
  await post(blog, { guid: 'written', createdAt: future(1) });
  await post(show, { guid: 'spoken', createdAt: future(2) });

  const result = await run();

  assert.equal(result.items, 1);
  assert.match(sent.email[0].text, /spoken/);
  assert.doesNotMatch(sent.email[0].text, /written/);
});

test('one story reaching a reader twice is one alert', async () => {
  const userId = await reader();
  const a = await feed({ slug: 'wire-a' });
  const b = await feed({ slug: 'wire-b' });
  await accounts.follow(db, userId, a);
  await accounts.follow(db, userId, b);
  await alerts.setFeedAlerts(db, userId, a, true);
  await alerts.setFeedAlerts(db, userId, b, true);

  await run();

  // Two feeds carrying the same story, which is what the cluster key is for.
  await post(a, { guid: 'a1', title: 'Syndicated', createdAt: future(1), clusterKey: 'same-story' });
  await post(b, { guid: 'b1', title: 'Syndicated', createdAt: future(2), clusterKey: 'same-story' });

  const result = await run();
  assert.equal(result.items, 1);
});

test('a truncated batch leaves the rest behind the watermark rather than skipping it', async () => {
  const userId = await reader();
  const blog = await feed({ slug: 'busy-blog' });
  await accounts.follow(db, userId, blog);
  await alerts.setFeedAlerts(db, userId, blog, true);

  await run();
  for (let i = 1; i <= 5; i += 1) {
    await post(blog, { guid: `p${i}`, title: `Post ${i}`, createdAt: future(i) });
  }

  const first = await run({ itemsPerMessage: 2 });
  assert.equal(first.items, 2);
  assert.match(sent.email[0].text, /Post 1/);
  assert.match(sent.email[0].text, /Post 2/);

  const second = await run({ itemsPerMessage: 2 });
  assert.equal(second.items, 2, 'the next two, in order, rather than the newest two');
  assert.match(sent.email[1].text, /Post 3/);

  const third = await run({ itemsPerMessage: 2 });
  assert.equal(third.items, 1);
  assert.match(sent.email[2].text, /Post 5/);

  // Five posts, five alerts, no repeats — which is the invariant the whole
  // watermark-plus-sent-log arrangement exists to hold.
  const all = sent.email.map((m) => m.text).join('\n');
  for (let i = 1; i <= 5; i += 1) {
    assert.equal(all.split(`Post ${i}`).length - 1, 1, `Post ${i} sent exactly once`);
  }
});

test('a capped source holds the watermark back for the others', async () => {
  const userId = await reader();
  const fast = await feed({ slug: 'fast-blog' });
  const slow = await feed({ slug: 'slow-blog' });
  await topic(fast, 'busy');
  await accounts.follow(db, userId, slow);
  await alerts.setFeedAlerts(db, userId, slow, true);
  await accounts.followTopic(db, userId, 'busy');
  await alerts.setTopicAlerts(db, userId, 'busy', '', true);

  await run();

  // The topic fills its read limit early in the window; the blog publishes
  // after everything the topic query could return. A watermark that jumped to
  // the newest row seen would step straight over the topic's remainder.
  for (let i = 1; i <= 4; i += 1) {
    await post(fast, { guid: `t${i}`, title: `Topic ${i}`, createdAt: future(i) });
  }
  await post(slow, { guid: 'late', title: 'Late post', createdAt: future(9) });

  await run({ perSource: 2, itemsPerMessage: 50 });
  await run({ perSource: 2, itemsPerMessage: 50 });
  await run({ perSource: 2, itemsPerMessage: 50 });

  const all = sent.email.map((m) => m.text).join('\n');
  for (let i = 1; i <= 4; i += 1) {
    assert.equal(all.split(`Topic ${i}`).length - 1, 1, `Topic ${i} arrived exactly once`);
  }
  assert.equal(all.split('Late post').length - 1, 1, 'and so did the blog post behind it');
});

test('every channel gets the batch, in its own shape', async () => {
  const userId = await reader();
  await alerts.addChannel(db, {
    userId,
    kind: 'web',
    target: 'https://push.example.com/abc',
    secret: { p256dh: 'k', auth: 'a' },
  });
  await alerts.addChannel(db, { userId, kind: 'webhook', target: 'https://hooks.example.com/x' });

  const blog = await feed({ slug: 'multi', title: 'Multi' });
  await accounts.follow(db, userId, blog);
  await alerts.setFeedAlerts(db, userId, blog, true);

  await run({ vapid: { publicKey: 'p', privateKey: 'k', subject: 'mailto:x@y.z' } });
  await post(blog, { guid: 'one', title: 'Only post', createdAt: future(1) });

  const result = await run({ vapid: { publicKey: 'p', privateKey: 'k', subject: 'mailto:x@y.z' } });

  assert.equal(result.sent, 3);
  assert.equal(sent.email.length, 1);

  assert.equal(sent.push[0].payload.title, 'Only post', 'a single post is its own notification');
  assert.equal(sent.push[0].payload.url, 'https://example.com/one', 'and the tap goes to it');

  assert.equal(sent.webhook[0].payload.version, 1);
  assert.equal(sent.webhook[0].payload.count, 1);
  assert.equal(sent.webhook[0].payload.items[0].feed.title, 'Multi');
});

test('push is skipped rather than failed when the deployment has no keys', async () => {
  const userId = await reader('nokeys@example.com');
  await alerts.addChannel(db, {
    userId,
    kind: 'web',
    target: 'https://push.example.com/nokeys',
    secret: { p256dh: 'k', auth: 'a' },
  });

  const blog = await feed({ slug: 'nopush' });
  await accounts.follow(db, userId, blog);
  await alerts.setFeedAlerts(db, userId, blog, true);

  await run({ vapid: null });
  await post(blog, { guid: 'x', createdAt: future(1) });
  const result = await run({ vapid: null });

  assert.equal(sent.push.length, 0);
  assert.equal(result.failed, 0, 'a missing key is the deployment’s state, not the channel’s fault');

  const [channel] = (await alerts.channelsForUser(db, userId)).filter((c) => c.kind === 'web');
  assert.equal(Number(channel.failures), 0, 'so it must not count towards retirement');
});

test('a channel that keeps failing retires itself', async () => {
  const userId = await reader('failing@example.com');
  const blog = await feed({ slug: 'failing' });
  await accounts.follow(db, userId, blog);
  await alerts.setFeedAlerts(db, userId, blog, true);

  await deliverAlerts(db, { transport: recorder(), origin: 'https://x.test' });

  for (let i = 1; i <= alerts.MAX_CHANNEL_FAILURES; i += 1) {
    await post(blog, { guid: `f${i}`, createdAt: future(i) });
    await deliverAlerts(db, {
      transport: recorder({ email: { ok: false, error: 'resend-500' } }),
      origin: 'https://x.test',
    });
  }

  const [channel] = await alerts.channelsForUser(db, userId);
  assert.equal(Number(channel.enabled), 0);
  assert.match(String(channel.last_error), /resend-500/);

  // And an account whose every channel has retired is no longer a candidate at
  // all, so the sender stops spending queries on it.
  assert.equal((await alerts.usersWithAlerts(db)).length, 0);
});

test('an endpoint reported gone is retired at once', async () => {
  const userId = await reader('gone@example.com');
  await alerts.addChannel(db, {
    userId,
    kind: 'web',
    target: 'https://push.example.com/gone',
    secret: { p256dh: 'k', auth: 'a' },
  });

  const blog = await feed({ slug: 'gone-blog' });
  await accounts.follow(db, userId, blog);
  await alerts.setFeedAlerts(db, userId, blog, true);

  const vapid = { publicKey: 'p', privateKey: 'k', subject: 'mailto:x@y.z' };
  await deliverAlerts(db, { transport: recorder(), origin: 'https://x.test', vapid });
  await post(blog, { guid: 'g1', createdAt: future(1) });

  await deliverAlerts(db, {
    transport: recorder({ push: { ok: false, gone: true, error: 'push-410' } }),
    origin: 'https://x.test',
    vapid,
  });

  const [web] = (await alerts.channelsForUser(db, userId)).filter((c) => c.kind === 'web');
  assert.equal(Number(web.enabled), 0, 'one 410 is enough — the browser is not coming back');
  assert.equal(Number(web.failures), 1);
});

test('an account with no channel is never considered', async () => {
  const user = await accounts.findOrCreateUser(db, 'channel-less@example.com');
  const blog = await feed({ slug: 'unheard-of' });
  await accounts.follow(db, String(user.id), blog);
  await alerts.setFeedAlerts(db, String(user.id), blog, true);

  assert.equal((await alerts.usersWithAlerts(db)).length, 0);
  assert.equal((await run()).users, 0);
});

/**
 * An ISO timestamp `minutes` into the future.
 *
 * The watermark is set to "now" on the first pass, so everything a test wants
 * alerted has to be stamped after that — and stamped in a fixed order, because
 * the whole point of several of these is what happens between two rows.
 *
 * @param {number} minutes
 * @returns {string}
 */
function future(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}
