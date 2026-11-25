import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

process.env['CROSS_PROMO'] = 'bundled';
process.env['SITE_URL'] = 'https://rssamp.com';

const { q } = await import('@rssamplifier/db');
const { connectTest } = await import('@rssamplifier/db/src/testdb.js');
const { notifyFinishedSubmissions, submissionEmail } = await import('../src/notify.js');

let db;

before(async () => {
  db = await connectTest();
});

after(async () => {
  db.close();
});

/** A send stub that records what it was asked to send. */
function recorder() {
  const sent = [];
  return {
    sent,
    async send(params) {
      sent.push({ params, message: await submissionEmail(params) });
      return { ok: true, id: `msg-${sent.length}` };
    },
  };
}

/** A feed row, optionally stamped as queued by a submission. */
async function feed(slug, opts = {}) {
  await q.insertFeed(db, {
    slug,
    feed_url: `https://${slug}.example/feed.xml`,
    site_url: `https://${slug}.example/`,
    title: opts.title ?? slug,
    status: opts.status ?? 'active',
  });
  if (opts.submissionId) {
    await db.execute({
      sql: 'update feeds set submission_id = ?, status = ?, last_error = ? where slug = ?',
      args: [opts.submissionId, opts.status ?? 'active', opts.lastError ?? null, slug],
    });
  }
}

test('a single feed found already listed is mailed once, naming it', async () => {
  await feed('already-here', { title: 'Already Here' });
  await q.insertSubmission(db, { id: 'sub-listed', kind: 'url', raw_input: 'already-here.example' });
  await q.completeSubmission(db, 'sub-listed', {
    accepted_count: 1,
    notify_email: 'me@example.com',
    accepted: [{ slug: 'already-here', existing: true }],
  });

  const r = recorder();
  const first = await notifyFinishedSubmissions(db, 10, { send: r.send });
  assert.equal(first.sent, 1);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].params.to, 'me@example.com');
  assert.equal(r.sent[0].message.subject, 'Your feed is listed on RSSAmp');
  assert.match(r.sent[0].message.text, /Already Here: Already listed/);

  // Retries and restarts never send it again.
  const again = await notifyFinishedSubmissions(db, 10, { send: r.send });
  assert.deepEqual(again, { sent: 0, failed: 0 });
  assert.equal(r.sent.length, 1);
});

test('a queued list waits for its last feed, then sends one summary', async () => {
  await q.insertSubmission(db, { id: 'sub-list', kind: 'list', raw_input: 'a\nb\nc' });
  await feed('list-a', { submissionId: 'sub-list', status: 'active', title: 'List A' });
  await feed('list-b', { submissionId: 'sub-list', status: 'error', lastError: 'http-404' });
  await feed('list-c', { submissionId: 'sub-list', status: 'pending' });
  await q.completeSubmission(db, 'sub-list', {
    queued_count: 3,
    already_listed: 2,
    rejected_count: 1,
    errors: [{ url: 'not a url', error: 'invalid-url' }],
    notify_email: 'lister@example.com',
  });

  const r = recorder();
  await notifyFinishedSubmissions(db, 10, { send: r.send });
  assert.equal(r.sent.length, 0, 'a feed is still pending');

  await db.execute({ sql: "update feeds set status = 'active' where slug = 'list-c'", args: [] });
  await notifyFinishedSubmissions(db, 10, { send: r.send });
  assert.equal(r.sent.length, 1);

  const { params, message } = r.sent[0];
  assert.equal(params.added, 2);
  assert.equal(params.listed, 2);
  assert.equal(params.failed, 2);
  assert.equal(message.subject, '4 of your 6 feeds are listed on RSSAmp');
  assert.match(message.text, /List A: Added/);
  assert.match(message.text, /Not added: the site answered HTTP 404/);
  assert.match(message.text, /not a url: Not added: not a usable address/);
  assert.match(message.text, /Full status: https:\/\/rssamp\.com\/submissions\/sub-list/);
});

test('a submission with no address is never mailed', async () => {
  await q.insertSubmission(db, { id: 'sub-anon', kind: 'url', raw_input: 'x' });
  await q.completeSubmission(db, 'sub-anon', { accepted_count: 1, accepted: [{ slug: 'already-here', existing: true }] });
  const r = recorder();
  await notifyFinishedSubmissions(db, 10, { send: r.send });
  assert.equal(r.sent.length, 0);
});

test('a failed send is not retried', async () => {
  await q.insertSubmission(db, { id: 'sub-bounce', kind: 'url', raw_input: 'x' });
  await q.completeSubmission(db, 'sub-bounce', {
    accepted_count: 1,
    notify_email: 'bounce@example.com',
    accepted: [{ slug: 'already-here', existing: true }],
  });
  let calls = 0;
  const send = async () => {
    calls += 1;
    return { ok: false, error: 'resend-422' };
  };
  assert.deepEqual(await notifyFinishedSubmissions(db, 10, { send }), { sent: 0, failed: 1 });
  assert.deepEqual(await notifyFinishedSubmissions(db, 10, { send }), { sent: 0, failed: 0 });
  assert.equal(calls, 1);
});

test('only one of two concurrent claims wins', async () => {
  await q.insertSubmission(db, { id: 'sub-race', kind: 'url', raw_input: 'x' });
  const [a, b] = await Promise.all([q.claimSubmissionNotice(db, 'sub-race'), q.claimSubmissionNotice(db, 'sub-race')]);
  assert.equal(Number(a) + Number(b), 1);
});
