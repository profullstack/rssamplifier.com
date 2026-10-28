import assert from 'node:assert/strict';
import { test, after } from 'node:test';

import { accounts, newsletter, nowIso } from '../index.js';
import { connectTest } from '../src/testdb.js';

/** The signup checkbox rides on the emailed link, like the profile does. */

const db = await connectTest({ prefix: 'rssamp_nl_signup' });
after(() => db.close());

test('a login token carries the newsletter choice, and a plain sign-in carries none', async () => {
  await accounts.insertLoginToken(db, { tokenHash: 'h-off', email: 'Off@Example.com', expiresAt: nowIso(60_000), newsletter: false });
  await accounts.insertLoginToken(db, { tokenHash: 'h-on', email: 'on@example.com', expiresAt: nowIso(60_000), newsletter: true });
  await accounts.insertLoginToken(db, { tokenHash: 'h-plain', email: 'plain@example.com', expiresAt: nowIso(60_000) });
  assert.equal((await accounts.takeLoginToken(db, 'h-off'))?.newsletter, false);
  assert.equal((await accounts.takeLoginToken(db, 'h-on'))?.newsletter, true);
  assert.equal((await accounts.takeLoginToken(db, 'h-plain'))?.newsletter, null);
});

test('new accounts start on the list; the count says so', async () => {
  const a = await accounts.findOrCreateUser(db, 'count-a@example.com');
  const b = await accounts.findOrCreateUser(db, 'count-b@example.com');
  await newsletter.setSubscribed(db, b.id, false);
  const size = await newsletter.listSize(db);
  assert.ok(size.subscribers >= 1);
  assert.equal(await newsletter.subscribed(db, a.id), true);
  assert.equal(await newsletter.subscribed(db, b.id), false);
});
