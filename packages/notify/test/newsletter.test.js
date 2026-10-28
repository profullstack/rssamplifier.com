import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { accounts, newsletter, nowIso, q } from '@rssamplifier/db';
import { connectTest } from '@rssamplifier/db/src/testdb.js';

import {
  UNSUBSCRIBE_SLOT,
  isoWeek,
  listHeaders,
  nextSlot,
  personalize,
  renderIssue,
  runNewsletter,
  slotConfig,
  slotOfWeek,
} from '../src/newsletter.js';

/**
 * The weekly digest against a real database: the slot, the one issue per
 * week, the claim-before-send that keeps a restart from mailing anybody
 * twice, and a dry run that writes nothing.
 */

let db;
let sent;

const transport = (outcome = { ok: true }) => ({
  enabled: () => true,
  send: async (m) => {
    sent.push(m);
    return outcome;
  },
});

const env = { SITE_URL: 'https://rssamplifier.test' };
// Monday 2026-11-02 is in ISO week 45; its slot is 15:00 UTC.
const MONDAY_SLOT = new Date('2026-11-02T15:00:00Z');
const after1h = new Date(MONDAY_SLOT.getTime() + 3_600_000);

beforeEach(async () => {
  db?.close();
  db = await connectTest({ prefix: 'rssamp_newsletter' });
  sent = [];
});

after(() => db?.close());

async function seedDirectory() {
  const feed = await q.insertFeed(db, {
    feed_url: 'https://fresh.example.com/feed.xml',
    site_url: 'https://fresh.example.com/',
    title: 'Fresh Blog',
    slug: 'fresh-blog',
  });
  await db.execute({
    sql: `update feeds set status = 'active', item_count = 3, created_at = ?, last_published_at = ? where id = ?`,
    args: [new Date(after1h.getTime() - 86_400_000).toISOString(), after1h.toISOString(), feed.id],
  });
  return String(feed.id);
}

test('isoWeek follows ISO 8601, including the year boundary', () => {
  assert.equal(isoWeek(new Date('2026-10-28T12:00:00Z')), '2026-W44');
  assert.equal(isoWeek(new Date('2026-11-02T00:00:00Z')), '2026-W45');
  assert.equal(isoWeek(new Date('2027-01-01T12:00:00Z')), '2026-W53');
  assert.equal(isoWeek(new Date('2021-01-03T12:00:00Z')), '2020-W53');
});

test('the slot is Monday 15:00 UTC unless NEWSLETTER_SLOT says otherwise', () => {
  const wed = new Date('2026-10-28T16:00:00Z');
  assert.equal(slotOfWeek(wed).toISOString(), '2026-10-26T15:00:00.000Z');
  assert.equal(nextSlot(wed).toISOString(), '2026-11-02T15:00:00.000Z');
  const fri = slotConfig({ NEWSLETTER_SLOT: 'FRI 15:00' });
  assert.deepEqual(fri, { day: 5, hour: 15 });
  assert.equal(slotOfWeek(wed, fri).toISOString(), '2026-10-30T15:00:00.000Z');
  assert.deepEqual(slotConfig({ NEWSLETTER_SLOT: 'nonsense' }), { day: 1, hour: 15 });
});

test('renderIssue drops empty sections and returns null when nothing happened', () => {
  const empty = { newFeeds: [], newFeedCount: 0, followed: [], liked: [], rings: [], joined: [] };
  assert.equal(renderIssue(empty, { week: '2026-W45' }), null);

  const issue = renderIssue(
    { ...empty, newFeedCount: 12, newFeeds: [{ slug: 'a', title: 'A <b>', description: 'x' }] },
    { week: '2026-W45', origin: 'https://r.test' },
  );
  assert.ok(issue);
  assert.match(issue.subject, /12 new feeds/);
  assert.match(issue.text, /NEW IN THE DIRECTORY/);
  assert.doesNotMatch(issue.text, /WEBRINGS/);
  assert.match(issue.html, /A &lt;b&gt;/);
  assert.ok(issue.text.includes(UNSUBSCRIBE_SLOT));
  const mine = personalize(issue, 'https://r.test/newsletter/unsubscribe?u=1&t=abc');
  assert.ok(!mine.text.includes(UNSUBSCRIBE_SLOT));
  assert.match(mine.html, /u=1&amp;t=abc/);
});

test('listHeaders carries the one-click unsubscribe', () => {
  const h = listHeaders('https://r.test/u');
  assert.equal(h['List-Unsubscribe'], '<https://r.test/u>');
  assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('accounts are on the list by default; the flag and the token behave', async () => {
  const user = await accounts.findOrCreateUser(db, 'reader@example.com');
  assert.equal(await newsletter.subscribed(db, user.id), true);
  const token = await newsletter.tokenFor(db, user.id);
  assert.ok(token.length >= 20);
  assert.equal(await newsletter.tokenFor(db, user.id), token, 'token is stable once made');
  assert.equal(await newsletter.userForToken(db, user.id, 'x'.repeat(24)), null);
  assert.equal((await newsletter.userForToken(db, user.id, token))?.email, 'reader@example.com');
  await newsletter.setSubscribed(db, user.id, false);
  assert.equal(await newsletter.subscribed(db, user.id), false);
});

test('before the slot nothing happens; after the window a fresh week is skipped', async () => {
  await seedDirectory();
  await accounts.findOrCreateUser(db, 'a@example.com');
  const early = await runNewsletter(db, { now: new Date('2026-11-02T14:59:00Z'), env, transport: transport(), gapMs: 0 });
  assert.equal(early.status, 'waiting');
  const late = await runNewsletter(db, { now: new Date('2026-11-04T16:00:00Z'), env, transport: transport(), gapMs: 0 });
  assert.equal(late.status, 'missed-window');
  assert.equal(sent.length, 0);
});

test('dry run writes nothing and sends nothing', async () => {
  await seedDirectory();
  await accounts.findOrCreateUser(db, 'a@example.com');
  await accounts.findOrCreateUser(db, 'b@example.com');
  const r = await runNewsletter(db, { now: after1h, env, dryRun: true, transport: transport(), gapMs: 0 });
  assert.equal(r.status, 'dry-run');
  assert.equal(r.recipients, 2);
  assert.equal(sent.length, 0);
  assert.equal(await newsletter.issueFor(db, '2026-W45'), null);
  assert.deepEqual(await newsletter.sendCounts(db, '2026-W45'), {});
});

test('a week goes to every subscriber once, in batches, never twice', async () => {
  await seedDirectory();
  for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) await accounts.findOrCreateUser(db, e);
  const off = await accounts.findOrCreateUser(db, 'off@example.com');
  await newsletter.setSubscribed(db, off.id, false);

  const first = await runNewsletter(db, { now: after1h, env, limit: 2, transport: transport(), gapMs: 0 });
  assert.equal(first.status, 'sending');
  assert.equal(sent.length, 2);
  const second = await runNewsletter(db, { now: after1h, env, limit: 2, transport: transport(), gapMs: 0 });
  assert.equal(second.status, 'finished');
  assert.equal(sent.length, 3);
  const again = await runNewsletter(db, { now: new Date(after1h.getTime() + 86_400_000), env, transport: transport(), gapMs: 0 });
  assert.equal(again.status, 'sent');
  assert.equal(sent.length, 3);

  const to = sent.map((m) => m.to).sort();
  assert.deepEqual(to, ['a@example.com', 'b@example.com', 'c@example.com']);
  for (const m of sent) {
    assert.match(m.headers['List-Unsubscribe'], /^<https:\/\/rssamplifier\.test\/newsletter\/unsubscribe\?u=/);
    assert.ok(!m.text.includes(UNSUBSCRIBE_SLOT));
    assert.match(m.subject, /new feeds/);
  }
  const issue = await newsletter.issueFor(db, '2026-W45');
  assert.equal(issue?.sent_count, 3);
  assert.ok(issue?.finished_at);
});

test('a reader already claimed for the week is skipped even if the send never finished', async () => {
  await seedDirectory();
  const a = await accounts.findOrCreateUser(db, 'a@example.com');
  await accounts.findOrCreateUser(db, 'b@example.com');
  // Build the issue, then pretend a crashed pass had claimed `a`.
  await runNewsletter(db, { now: after1h, env, limit: 0, transport: transport(), gapMs: 0 });
  assert.equal(await newsletter.claimSend(db, '2026-W45', a.id), true);
  await runNewsletter(db, { now: after1h, env, transport: transport(), gapMs: 0 });
  assert.deepEqual(sent.map((m) => m.to), ['b@example.com']);
  assert.equal(nowIso().length > 0, true);
});

test('NEWSLETTER_SEND=0 builds nothing out and mails nobody', async () => {
  await seedDirectory();
  await accounts.findOrCreateUser(db, 'a@example.com');
  const r = await runNewsletter(db, { now: after1h, env: { ...env, NEWSLETTER_SEND: '0' }, transport: transport(), gapMs: 0 });
  assert.equal(r.status, 'disabled');
  assert.equal(sent.length, 0);
});
