import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { accounts, apikeys } from '@rssamplifier/db';
import { connectTest } from '@rssamplifier/db/src/testdb.js';
import { newApiKey } from '@rssamplifier/auth';

/**
 * /api/v1/webhooks and the webhook MCP tools, against a real database.
 *
 * lib/db.js opens DATABASE_URL on first use, so this points it at a throwaway
 * test database before importing anything that reaches for it.
 */

let db;
let lib;
let tools;
let token;
let userId;
let api;

before(async () => {
  db = await connectTest();
  const url = new URL(process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5439/postgres');
  url.pathname = `/${db.databaseName}`;
  process.env['DATABASE_URL'] = url.toString();

  lib = await import('../src/lib/webhooks.js');
  ({ WEBHOOK_TOOLS: tools } = await import('../src/lib/mcp/webhookTools.js'));
  // No session in a test: next/headers only works inside a request.
  api = lib.makeWebhooksHandler({ user: async () => null });

  const user = await accounts.findOrCreateUser(db, 'hooks@example.com');
  userId = String(user.id);
  const minted = newApiKey();
  await apikeys.insertKey(db, { userId, name: 'test', prefix: minted.prefix, hash: minted.hash });
  token = minted.token;
});

after(async () => {
  const { db: shared } = await import('../src/lib/db.js');
  shared().close();
  db?.close();
});

const req = (path, init = {}) => new Request(`https://rssamplifier.com${path}`, init);

test('the API answers 401 without a credential', async () => {
  const res = await api(req('/api/v1/webhooks'));
  assert.equal(res.status, 401);
});

test('an API key lists its account\'s endpoints and the event types', async () => {
  const res = await api(req('/api/v1/webhooks', { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.event_types, ['posts.published']);
  assert.deepEqual(body.endpoints, []);
});

test('a private or plain-http URL is refused', async () => {
  for (const url of ['http://hooks.example.com/x', 'https://127.0.0.1/x']) {
    const res = await api(
      req('/api/v1/webhooks', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      }),
    );
    assert.equal(res.status, 400, url);
  }
});

test('paths outside the mount are not the handler\'s', async () => {
  assert.equal(await api(req('/api/v1/other')), null);
});

test('the MCP tools act for the key\'s account and refuse without one', async () => {
  const list = tools.find((t) => t.name === 'list_webhooks');
  const anon = { header: () => null };
  await assert.rejects(list.run({}, anon), (err) => err.toolError === true);

  const authed = { header: (name) => (name === 'authorization' ? `Bearer ${token}` : null) };
  const hub = lib.hooks();
  // Created through the hub directly: the URL check resolves DNS, which a test
  // should not depend on.
  await hub.store.insertEndpoint({
    id: 'wh_test',
    owner: userId,
    url: 'https://hooks.example.com/x',
    secret: 'whsec_dGVzdA==',
    events: ['*'],
    description: 'relay',
    enabled: true,
    failures: 0,
    disabledReason: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const out = await list.run({}, authed);
  assert.equal(out.endpoints.length, 1);
  assert.equal(out.endpoints[0].description, 'relay');
  assert.equal('secret' in out.endpoints[0], false, 'never the secret in a listing');

  const rotate = tools.find((t) => t.name === 'rotate_webhook_secret');
  const { secret } = await rotate.run({ id: 'wh_test' }, authed);
  assert.match(secret, /^whsec_/);

  const del = tools.find((t) => t.name === 'delete_webhook');
  await assert.rejects(del.run({ id: 'wh_nope' }, authed), (err) => err.toolError === true);
  assert.deepEqual(await del.run({ id: 'wh_test' }, authed), { deleted: true });
});
